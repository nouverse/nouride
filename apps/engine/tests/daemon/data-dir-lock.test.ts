/**
 * The daemon's lock on its data directory, as boot takes it.
 *
 * After an unclean stop, a container started again reuses PIDs, and its lock named a live process that was not Nouride:
 * "another Nouride instance is running (PID 9)", on every restart (REGISTER_14 `stale-lock-in-containers`). Boot takes
 * a lock like that over and says so at warn, and still refuses one held by a live Nouride.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processCommandLine } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { takeDataDirLock } from "@/boot/lock.ts";
import { eventually } from "../wait.ts";

const entries: LogEntry[] = [];
addLogSink((entry) => entries.push(entry));

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function live(...argv: string[]): Promise<number> {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
  children.push(child);
  await eventually(() => (processCommandLine(child.pid!) ?? "").includes("sleep"), 4_000, "the child to be running its command");
  return child.pid!;
}

function dataDirWithLock(pid: number): string {
  const dir = mkdtempSync(join(tmpdir(), "nouride-datadir-lock-"));
  dirs.push(dir);
  writeFileSync(join(dir, "nouride.lock"), `${pid}\n`);
  return dir;
}

describe("the data directory's lock at boot", () => {
  test("naming a live process that is not Nouride, is taken over, with a warning that names it", async () => {
    const pid = await live("sleep", "30");
    const dir = dataDirWithLock(pid);
    const lock = takeDataDirLock(dir);
    expect(readFileSync(join(dir, "nouride.lock"), "utf8")).toBe(String(process.pid));
    const warned = entries.find((entry) => entry.message.startsWith("took over a stale lock") && entry.data?.lock === join(dir, "nouride.lock"));
    expect(warned?.level).toBe("warn");
    expect(String(warned?.data?.why)).toContain(`PID ${pid} is now`);
    lock.release();
  });

  test("naming a live Nouride, is refused, and the lock is left as it was", async () => {
    const pid = await live("sh", "-c", "sleep 30; :", "nouride");
    const dir = dataDirWithLock(pid);
    expect(() => takeDataDirLock(dir)).toThrow(`another Nouride instance is running (PID ${pid})`);
    expect(readFileSync(join(dir, "nouride.lock"), "utf8")).toBe(`${pid}\n`);
  });
});
