import { describe, expect, test } from "bun:test";
import { describeStop, looksLikeDaemon, stopDaemon, type StopDeps } from "@/cli/stop.ts";

interface Probe extends StopDeps {
  removed: boolean;
  signals: { pid: number; signal: string }[];
  waited: number;
}

/**
 * A daemon in whatever state the test needs.
 *
 * `clearsAfter` is how many lock polls it takes to shut down — `undefined` means it never does, which is
 * the stuck-shutdown case.
 */
function probe(opts: {
  pid?: string | null;
  alive?: boolean;
  command?: string | null;
  clearsAfter?: number;
}): Probe {
  let polls = 0;
  const p: Probe = {
    removed: false,
    signals: [],
    waited: 0,
    readLock: () => (opts.pid === undefined ? "4242" : opts.pid),
    removeLock: () => {
      p.removed = true;
    },
    lockExists: () => {
      polls += 1;
      return opts.clearsAfter === undefined ? true : polls < opts.clearsAfter;
    },
    isAlive: () => opts.alive ?? true,
    commandLine: () => (opts.command === undefined ? "bun run /home/me/nouride/apps/engine/src/index.ts" : opts.command),
    signal: (pid, signal) => {
      p.signals.push({ pid, signal });
      return true;
    },
    wait: async (ms) => {
      p.waited += ms;
    },
  };
  return p;
}

describe("stopping a daemon", () => {
  test("SIGTERM, then success once the lock clears", async () => {
    const p = probe({ clearsAfter: 3 });
    const outcome = await stopDaemon(p, 10_000);

    expect(outcome).toEqual({ kind: "stopped", pid: 4242 });
    expect(p.signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    // Returned as soon as the lock went, rather than sitting out the full grace period.
    expect(p.waited).toBeLessThan(10_000);
  });

  test("a daemon that never releases the lock is reported, not escalated", async () => {
    const p = probe({ clearsAfter: undefined });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome).toEqual({ kind: "signalled", pid: 4242 });
    // No SIGKILL. A stuck shutdown killed mid-checkpoint is how the database gets damaged.
    expect(p.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    expect(describeStop(outcome).ok).toBe(false);
  });

  test("the wait is bounded by the grace period", async () => {
    const p = probe({ clearsAfter: undefined });
    await stopDaemon(p, 1000);

    // Bounded, and it actually waited — a loop that exits immediately would pass an upper bound alone.
    expect(p.waited).toBeLessThanOrEqual(1000);
    expect(p.waited).toBeGreaterThan(0);
  });

  test("no lock file means nothing to stop, and that is not a failure", async () => {
    const outcome = await stopDaemon(probe({ pid: null }), 1000);

    expect(outcome).toEqual({ kind: "not_running" });
    expect(describeStop(outcome).ok).toBe(true);
  });

  test("a lock naming a dead process is cleaned up without signalling", async () => {
    const p = probe({ alive: false });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome).toEqual({ kind: "stale_lock", pid: 4242 });
    expect(p.removed).toBe(true);
    expect(p.signals).toEqual([]);
    expect(describeStop(outcome).ok).toBe(true);
  });

  test("a lock file with no PID in it is left in place", async () => {
    const p = probe({ pid: "not-a-pid\n" });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome).toEqual({ kind: "unreadable_lock" });
    // Deleting it would let a second daemon start on the same data directory — the split brain the lock
    // exists to prevent.
    expect(p.removed).toBe(false);
    expect(p.waited).toBe(0);
  });

  test("a recycled PID belonging to something else is never signalled", async () => {
    const p = probe({ command: "/usr/sbin/sshd -D" });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome).toEqual({ kind: "pid_reused", pid: 4242, command: "/usr/sbin/sshd -D" });
    expect(p.signals).toEqual([]);
    expect(p.removed).toBe(false);
    const { ok, hint } = describeStop(outcome);
    expect(ok).toBe(false);
    expect(hint).toContain("sshd");
  });

  test("an unreadable command line is refused rather than assumed to be ours", async () => {
    const p = probe({ command: null });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome.kind).toBe("pid_reused");
    expect(p.signals).toEqual([]);
  });

  test("a negative PID is rejected before it can be signalled", async () => {
    // `process.kill(-n)` signals a process *group*. A lock file mangled into a negative number must not
    // become a broadcast.
    const p = probe({ pid: "-1" });
    const outcome = await stopDaemon(p, 1000);

    expect(outcome).toEqual({ kind: "unreadable_lock" });
    expect(p.signals).toEqual([]);
  });
});

describe("recognising the daemon in a command line", () => {
  test("accepts the ways it is legitimately started", () => {
    expect(looksLikeDaemon("bun run /home/me/nouride/apps/engine/src/index.ts")).toBe(true);
    expect(looksLikeDaemon("bun run /home/me/nouride/apps/engine/src/cli/main.ts start")).toBe(true);
    expect(looksLikeDaemon("/usr/local/bin/nouride start")).toBe(true);
  });

  test("rejects an unrelated process that inherited the PID", () => {
    expect(looksLikeDaemon("/usr/sbin/sshd -D")).toBe(false);
    expect(looksLikeDaemon("postgres: checkpointer")).toBe(false);
  });
});
