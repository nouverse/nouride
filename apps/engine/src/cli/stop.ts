/**
 * Stopping a daemon without going through the control API.
 *
 * `restart` already existed and goes over HTTP with a token — which is exactly the thing that is broken
 * when you most need to stop something. Three installs on one machine, all defaulting to the same port:
 * whichever daemon started first owns it, every other install's CLI gets a 401, and the only remedy was
 * to find the PID by hand. A diagnosis that ends in "stop that daemon" needs a way to stop it.
 *
 * Scope is deliberately narrow: this signals **the PID in this install's own lock file**, and nothing
 * else. It cannot be aimed at an arbitrary process, and it cannot reach another install's daemon — for
 * that you run it from that install's directory, which is also the only place you can prove you own it.
 */

export type StopOutcome =
  /** Signalled and the lock cleared. */
  | { kind: "stopped"; pid: number }
  /** Signalled, but the lock was still there when we gave up waiting. */
  | { kind: "signalled"; pid: number }
  /** No lock file: nothing to stop. */
  | { kind: "not_running" }
  /** A lock naming a process that no longer exists. Removed. */
  | { kind: "stale_lock"; pid: number }
  /** A lock we will not act on, because the PID is now something else. */
  | { kind: "pid_reused"; pid: number; command: string }
  /** A lock file we could not parse. Left alone — deleting it could free a live daemon's lock. */
  | { kind: "unreadable_lock" };

/**
 * Every effect this needs, injected.
 *
 * Including the process inspection, which the first version called directly — and that made the two
 * branches worth testing most (a daemon that shuts down, and one that ignores SIGTERM) unreachable from
 * a test, because reaching them needs a live process whose command line matches. Two of the tests written
 * against that version asserted something other than their name claimed, which is a worse outcome than
 * having no test: it reads as covered.
 */
export interface StopDeps {
  readLock(): string | null;
  removeLock(): void;
  lockExists(): boolean;
  isAlive(pid: number): boolean;
  commandLine(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals): boolean;
  /** Resolves after roughly `ms`. Injected so tests do not spend real seconds. */
  wait(ms: number): Promise<void>;
}

/**
 * Whether a command line still looks like the daemon that took the lock.
 *
 * Matching on "nouride" rather than an exact command: the daemon can be started as `bun run
 * apps/engine/src/index.ts`, through the CLI's `start`, from a compiled binary, or under a supervisor,
 * and all four are legitimate. What this rules out is the case worth ruling out — a recycled PID now
 * belonging to something with no relation to us.
 */
export function looksLikeDaemon(command: string): boolean {
  return command.toLowerCase().includes("nouride");
}

/**
 * SIGTERM, then wait for the lock to clear.
 *
 * The lock is released by the daemon's own shutdown path, so its disappearance is the signal that
 * shutdown *finished* — flushed, gateways closed, jobs settled. Waiting on the port to close instead
 * would report success while state was still being written.
 *
 * No SIGKILL escalation. A daemon that ignores SIGTERM for the whole grace period is one whose shutdown
 * is stuck, and killing it there is how a WAL gets left mid-checkpoint. It reports `signalled` and lets a
 * human decide.
 */
export async function stopDaemon(deps: StopDeps, graceMs: number): Promise<StopOutcome> {
  const raw = deps.readLock();
  if (raw === null) return { kind: "not_running" };

  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "unreadable_lock" };

  if (!deps.isAlive(pid)) {
    deps.removeLock();
    return { kind: "stale_lock", pid };
  }

  const command = deps.commandLine(pid);
  // A null command line means `ps` told us nothing while the process is alive — most likely another
  // user's process, which EPERM already reports as alive. Refusing is the conservative branch.
  if (command === null || !looksLikeDaemon(command)) {
    return { kind: "pid_reused", pid, command: command ?? "unknown" };
  }

  deps.signal(pid, "SIGTERM");

  const step = 200;
  for (let waited = 0; waited < graceMs; waited += step) {
    await deps.wait(step);
    if (!deps.lockExists()) return { kind: "stopped", pid };
  }

  return { kind: "signalled", pid };
}

/** One line for the operator, plus whether it counts as a failure. */
export function describeStop(outcome: StopOutcome): { text: string; ok: boolean; hint?: string } {
  switch (outcome.kind) {
    case "stopped":
      return { text: `daemon stopped (PID ${outcome.pid})`, ok: true };
    case "not_running":
      return { text: "no daemon is running for this install", ok: true };
    case "stale_lock":
      return {
        text: `removed a stale lock file (PID ${outcome.pid} is gone)`,
        ok: true,
      };
    case "signalled":
      return {
        text: `sent SIGTERM to PID ${outcome.pid}, but it has not finished shutting down`,
        ok: false,
        hint: "Its shutdown is stuck. Check the log before killing it: SIGKILL can leave the database mid-checkpoint.",
      };
    case "pid_reused":
      return {
        text: `the lock file names PID ${outcome.pid}, which is not a Nouride daemon`,
        ok: false,
        hint: `That PID is now \`${outcome.command}\`. Nothing was signalled. Delete the lock file yourself if you are sure the daemon is gone.`,
      };
    case "unreadable_lock":
      return {
        text: "the lock file does not contain a PID",
        ok: false,
        hint: "Left in place, because removing a live daemon's lock would let a second one start on the same data directory.",
      };
  }
}
