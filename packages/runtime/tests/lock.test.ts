import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLockFile, fileExists, processCommandLine, removePath } from "../src/index.ts";
import { eventually } from "./wait.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-lock-"));
  path = join(dir, "nouride.lock");
});

afterEach(() => {
  removePath(dir);
});

describe("acquireLockFile", () => {
  test("creates the lock and writes our PID", async () => {
    const lock = acquireLockFile(path);
    expect(await fileExists(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
    expect(await fileExists(path)).toBe(false);
  });

  test("refuses when the holder is alive", () => {
    // One daemon per data directory. SQLite's WAL survives two writers but nothing else does:
    // approval waiters, pause state, the rate-limit table and model overrides are per-process,
    // so a second daemon is split brain that reads as intermittent misbehaviour.
    const first = acquireLockFile(path);
    expect(() => acquireLockFile(path)).toThrow(/another Nouride instance is running/);
    first.release();
  });

  test("takes over a lock whose PID is gone", async () => {
    // A crash or `kill -9` leaves the file behind. Refusing forever would mean the daemon can
    // never start again without manual cleanup.
    writeFileSync(path, "999999");
    const lock = acquireLockFile(path);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
  });

  test("takes over a lock file that names no PID", () => {
    writeFileSync(path, "not a pid");
    const lock = acquireLockFile(path);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
  });

  // The test above read as covering this and never reached it: "not a pid" is readable, so it went the
  // dead-PID way. A file that cannot be read at all is the branch, and it had its own copy of `release`.
  test.skipIf(process.getuid?.() === 0)("takes over a lock file it cannot read, and releases it like any other", async () => {
    writeFileSync(path, "123");
    chmodSync(path, 0o000);
    const lock = acquireLockFile(path);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
    expect(await fileExists(path)).toBe(false);
  });

  // Where this runner is PID 1 — a container — the lock names this process, which is the other rule (below).
  test.skipIf(process.pid === 1)("treats PID 1 as alive rather than as a stale lock", () => {
    // PID 1 exists but is not ours to signal, so `process.kill(1, 0)` raises EPERM. An
    // ESRCH-only check reads that as dead and deletes a live daemon's lock; here it must refuse.
    writeFileSync(path, "1");
    expect(() => acquireLockFile(path)).toThrow(/another Nouride instance is running/);
  });

  test("release is safe to call twice", () => {
    const lock = acquireLockFile(path);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

/**
 * A PID is reused. A container started again after an unclean stop numbered its processes from 1 again, and its lock
 * named a live process that was not Nouride ("another Nouride instance is running (PID 9)") — or the new daemon
 * itself — so the daemon refused to start on every restart.
 */
describe("a lock naming a live process", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  const isNouride = (command: string) => command.includes("nouride");
  /** A live process, with the command line given. `; :` keeps the shell from exec'ing into `sleep` and losing it. */
  function live(...argv: string[]): number {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
    children.push(child);
    return child.pid!;
  }
  /** `ps` and `/proc` both see a process a moment after it is spawned. */
  async function seen(pid: number): Promise<void> {
    for (let i = 0; i < 50 && !(processCommandLine(pid) ?? "").includes("sleep"); i++) await Bun.sleep(20);
  }

  test("that is not a Nouride is stale: taken over, and the reason names what it is now", async () => {
    const pid = live("sleep", "30");
    await seen(pid);
    writeFileSync(path, String(pid));
    const lock = acquireLockFile(path, { heldBy: isNouride });
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    expect(lock.tookOver?.pid).toBe(pid);
    expect(lock.tookOver?.why).toContain("not a Nouride daemon");
    expect(lock.tookOver?.why).toContain("sleep 30");
    lock.release();
  });

  test("that is a Nouride holds it", async () => {
    const pid = live("sh", "-c", "sleep 30; :", "nouride");
    await seen(pid);
    writeFileSync(path, String(pid));
    expect(() => acquireLockFile(path, { heldBy: isNouride })).toThrow(`another Nouride instance is running (PID ${pid})`);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(pid));
  });

  test("whose command line cannot be read holds it: refusing to start is the side that can be undone", async () => {
    const pid = live("sleep", "30");
    await seen(pid);
    writeFileSync(path, String(pid));
    expect(() => acquireLockFile(path, { heldBy: isNouride, commandLine: () => null })).toThrow(/another Nouride instance is running/);
  });

  test("that is this very process, which did not take it, is stale: the daemon before had the same PID", () => {
    // A container running the binary directly starts it as the same PID every time.
    writeFileSync(path, String(process.pid));
    // Every live command line a holder, so nothing but this process's PID can make it stale.
    const lock = acquireLockFile(path, { heldBy: () => true });
    expect(lock.tookOver?.why).toContain("which is this process");
    lock.release();
  });

  test("a stale lock taken over says so; a free one does not", () => {
    const lock = acquireLockFile(path);
    expect(lock.tookOver).toBeNull();
    lock.release();
    writeFileSync(path, "999999");
    const again = acquireLockFile(path);
    expect(again.tookOver).toEqual({ pid: 999999, why: "PID 999999 is gone" });
    again.release();
  });
});

describe("processCommandLine", () => {
  test("is the program and its arguments", async () => {
    const child = spawn("sleep", ["31"], { stdio: "ignore" });
    try {
      // Until it has run `sleep`: between its fork and its exec, Linux reports the parent's command line, not none.
      await eventually(() => /sleep 31$/.test(processCommandLine(child.pid!) ?? ""), 4_000, "the child to exec");
      expect(processCommandLine(child.pid!)).toMatch(/sleep 31$/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
