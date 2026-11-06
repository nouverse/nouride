/**
 * A child as the leader of its own process group, and how to signal everything it started.
 *
 * Shared by the foreground path (`runCommand`) and background jobs (`process-background.ts`), which
 * is the reason it is a file: the jobs path skipped all of this for as long as the two lived apart,
 * so `nouride jobs kill` on `sh -c "npm run dev"` stopped `sh` and left `node` running.
 */

import { statFile } from "./fs.ts";

/**
 * Where `setsid(1)` lives, or null. util-linux, so Linux only — macOS has no such binary.
 */
function findSetsid(): string | null {
  if (process.platform !== "linux") return null;
  for (const candidate of ["/usr/bin/setsid", "/bin/setsid"]) {
    if (statFile(candidate)) return candidate;
  }
  return null;
}

/**
 * How a command becomes the leader of its own group here: `setsid(1)` on Linux, Bun's own `detached` on macOS — which
 * calls `setsid()` in the child, with no program to find — or not at all (a Linux image stripped of util-linux).
 *
 * macOS used to be the third case, so a timeout, an abort or `nouride jobs kill` reached `sh` and left what it started
 * running: `sleep 311 & sleep 312 & wait` under a short timeout left both sleeps behind (finding 7 of issue #7 on
 * nouride-releases). Linux keeps `setsid(1)`, unchanged.
 */
function groupMode(): "setsid" | "detached" | null {
  if (findSetsid()) return "setsid";
  return process.platform === "darwin" ? "detached" : null;
}

/** What to spread into `Bun.spawn`'s options beside {@link withOwnProcessGroup}'s argv: `detached` on macOS. */
export function ownGroupSpawnOptions(): { detached?: true } {
  return groupMode() === "detached" ? { detached: true } : {};
}

/**
 * Run the command as its own process group leader, so killing it kills what it started.
 *
 * ## The orphan this exists to prevent
 *
 * `proc.kill()` signals the direct child and nothing else. Whether that is enough depends on a
 * detail of the shell: for `sh -c "sleep 10"`, macOS's `sh` *execs* `sleep`, so the direct child
 * **is** the sleep and killing it works — while Debian's `sh` is dash, which **forks** it. Observed
 * on the live box: kill the shell and `sleep` is still running a second later, reparented to init.
 *
 * That orphan holds the inherited stdout and stderr pipes, so `readCapped` never sees EOF and
 * `runCommand` never returns. A timeout or an abort leaves the caller hanging *and* the work still
 * running — on every Linux box, which is every deployment. It surfaced as a test that timed out in
 * CI and passed on the developer's Mac, which is exactly the shape of bug this is.
 *
 * With `setsid` the child gets a new session and becomes its own group leader, so its pid doubles as
 * a group id and `kill(-pid)` reaches everything it spawned. On macOS, which has no `setsid(1)`, the
 * spawn's `detached` does the same ({@link ownGroupSpawnOptions}, spread beside this argv). Absent
 * both — a Linux image stripped of util-linux — the command runs unwrapped and the kill falls back
 * to the direct child.
 *
 * A new session is also out of reach of the terminal's Ctrl-C, which used to stop a daemon run in the
 * foreground and its children together. So whoever starts a group owns stopping it: the foreground
 * path kills it on timeout and abort, and a background job is stopped by `stop()` at shutdown.
 */
export function withOwnProcessGroup(cmd: string[]): string[] {
  const setsid = findSetsid();
  // `--wait` would make setsid block until the child exits, and then the pid we hold is setsid's,
  // not the leader's. Without it setsid execs, so the pid Bun reports is the group leader itself.
  return setsid ? [setsid, ...cmd] : cmd;
}

/**
 * Signal the child, and the group it leads if it has one.
 *
 * The negative pid is the whole group — and it is attempted **only** when the command was made a
 * group leader (`setsid`, or `detached` on macOS), never speculatively. Without either the child inherits the daemon's own group, so
 * its pid is not a group id; `-pid` would then either fail with `ESRCH` or, if some unrelated group
 * happens to carry that number, signal somebody else's processes. Catching the error is not enough,
 * because the dangerous case is the one that succeeds.
 */
export function signalTree(proc: { pid: number; kill: (signal: NodeJS.Signals) => void }, signal: NodeJS.Signals): void {
  if (groupMode() !== null) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Already gone, or it never became a leader. The direct signal below is then the whole job.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited between the two calls.
  }
}
