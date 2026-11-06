/**
 * Stopping a background job, and everything it started (P3/S5, 2026-10-15).
 *
 * `kill` used to be one SIGTERM to the direct child. `nouride jobs kill` on `sh -c "npm run dev"` then
 * stopped `sh` and left `node` running with the pipes open, so the pump never saw EOF and the row said
 * `running` for as long as the daemon lived — and at shutdown the same orphan survived `killAll`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackgroundCommand } from "../src/process-background.ts";
import { eventually, sleep } from "./wait.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-background-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir };
let count = 0;

function start(cmd: string[], extra: Partial<Parameters<typeof startBackgroundCommand>[1]> = {}) {
  const logPath = join(dir, `job-${count++}.log`);
  return { handle: startBackgroundCommand(cmd, { cwd: dir, env, logPath, ...extra }), logPath };
}

/** `exited`, or `"still running"` once `ms` has passed — so a hang fails the test instead of the run. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "still running"> {
  return Promise.race([promise, sleep(ms).then(() => "still running" as const)]);
}

/**
 * Running, from `/proc` — or `ps` on macOS, which has none: a zombie nobody has reaped yet answers `kill(0)` but is not
 * running anything.
 */
function running(pid: number): boolean {
  if (process.platform === "darwin") {
    const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()[0];
    return state !== undefined && state !== "Z";
  }
  // Read, not checked and then read: a process that exits between the two answers the read with ESRCH, which failed a
  // CI run of 0.8.0 (2026-10-25) at the very moment the test was waiting for — the process gone.
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.split(") ")[1]?.[0];
  return state !== undefined && state !== "Z" && state !== "X";
}

/** Where a job is its own process group: `setsid(1)` on Linux, `detached` on macOS (`process-group.ts`). */
const grouped = process.platform === "linux" || process.platform === "darwin";

describe("stop", () => {
  test("a job that honours SIGTERM is not held for the whole grace period", async () => {
    const { handle } = start(["sleep", "30"]);
    const began = Date.now();
    await handle.stop(10_000);
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(await within(handle.exited, 2_000)).toMatchObject({ signal: "SIGTERM" });
  });

  test("a job that ignores SIGTERM is killed when the grace period runs out", async () => {
    // One process, so this holds with or without `setsid`: the escalation is the property here.
    const { handle, logPath } = start([process.execPath, "-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"]);
    await eventually(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("ready"), 4_000, "the job to be ready");

    const began = Date.now();
    await handle.stop(400);
    expect(Date.now() - began).toBeGreaterThanOrEqual(350);
    expect(await within(handle.exited, 3_000)).toMatchObject({ signal: "SIGKILL" });
  });

  /**
   * The bug itself. `sh` forks `sleep` here — dash does, and so does any shell when the command is not
   * the last one — so the job's direct child is not the process holding the pipes.
   *
   * Linux and macOS: the group is `setsid(1)` on the one and the spawn's `detached` on the other. Elsewhere this
   * runtime signals the direct child alone.
   */
  test.skipIf(!grouped)("what the job started is stopped with it, so the job can finish", async () => {
    const { handle, logPath } = start(["sh", "-c", "sleep 300 & echo $!; wait"]);
    let child = 0;
    await eventually(() => (child = existsSync(logPath) ? Number(readFileSync(logPath, "utf8").trim()) || 0 : 0) > 0, 4_000, "the pid it started");
    expect(running(child)).toBe(true);

    await handle.stop(2_000);
    // Before, this never settled: the orphaned `sleep` held stdout open and the pump waited on it.
    expect(await within(handle.exited, 4_000)).not.toBe("still running");
    // The whole group was signalled at once, but the shell can be reaped a moment before the kernel has finished
    // the `sleep`: read straight after `exited`, it was still running about one run in six under load.
    await eventually(() => !running(child), 2_000, "the pid it started to be gone");
  });
});

describe("kill", () => {
  test.skipIf(!grouped)("reaches the whole group, not only the shell", async () => {
    const { handle, logPath } = start(["sh", "-c", "sleep 300 & echo started; wait"]);
    // Said once the shell has started its `sleep`, so there is a group beyond the shell to reach.
    await eventually(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("started"), 4_000, "the job to start");
    handle.kill("SIGTERM");
    expect(await within(handle.exited, 4_000)).not.toBe("still running");
  });
});

describe("the log (S5)", () => {
  test("is written through the filter: one per stream, the text whole across reads, what it held released at the end", async () => {
    const made: string[] = [];
    const filter = () => {
      made.push("filter");
      return { push: (text: string) => text.toUpperCase(), end: () => "<end>" };
    };
    // "é" is two bytes, written a read apart: a decoder per chunk would turn it into two replacement characters.
    const { handle, logPath } = start(["sh", "-c", "printf 'caf\\303'; sleep 0.2; printf '\\251 done\\n'; echo oops >&2"], { filter });
    await within(handle.exited, 5_000);

    const written = readFileSync(logPath, "utf8");
    expect(written).toContain("CAFÉ DONE");
    expect(written).toContain("OOPS");
    expect(written.split("<end>")).toHaveLength(3);
    expect(made).toEqual(["filter", "filter"]);
  });

  test("without one, the bytes go as they came", async () => {
    const { handle, logPath } = start(["sh", "-c", "printf 'caf\\303\\251\\n'"]);
    await within(handle.exited, 5_000);
    expect(readFileSync(logPath, "utf8")).toBe("café\n");
  });

  test.skipIf(process.platform !== "linux")("a job runs under the ceilings it is given", async () => {
    // `dd` mallocs its 128 MB block up front; under a 64 MB address-space ceiling the kernel refuses it.
    const { handle } = start(["dd", "if=/dev/zero", "of=/dev/null", "bs=128M", "count=1"], { limits: { memoryMb: 64 } });
    expect(await within(handle.exited, 5_000)).not.toMatchObject({ exitCode: 0 });
  });
});
