/**
 * One daemon per data directory: the lock file, and when one is stale.
 *
 * SQLite's WAL survives two writers, but nothing else here does: the approval gate's waiters, the registry's pause
 * state, the rate-limit table and the model overrides are all per-process, so a second daemon is split brain that
 * looks like intermittent misbehaviour rather than a clear failure.
 *
 * A lock names a PID, and a PID is reused. A container started again numbers its processes from 1 again, so after an
 * unclean stop the lock named a live process that was not Nouride — or the new daemon itself, which on a container
 * running the binary directly gets the same PID every time — and the daemon refused to start, on every restart, with
 * "another Nouride instance is running". The official image deletes the lock in its entrypoint; a container made by
 * hand, or a VM restored from a snapshot, did not. So a live PID holds the lock only when it is not this process and,
 * where the caller says what a holder looks like, its command line is one.
 *
 * What this cannot see is a daemon in another PID namespace — a second container on the same volume. A PID read
 * there means nothing here; the official image's entrypoint, which deletes the lock outright, could not see it either.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isProcessAlive } from "./fs.ts";
import { processCommandLine } from "./process.ts";

export interface LockOptions {
  /**
   * Whether a live process with this command line is one that would hold this lock — for the daemon, a Nouride.
   * Absent, every live process holds it. A command line that cannot be read holds it either way: a refusal to start
   * can be acted on, and two daemons on one data directory cannot.
   */
  heldBy?(command: string): boolean;
  /** How a PID's command line is read. The runtime's own; a test hands in one that cannot read anything. */
  commandLine?(pid: number): string | null;
}

/** A lock that was stale and is this process's now, and why — for the warning the caller writes. */
export interface TakenOver {
  /** The PID it named, or null when it named none. */
  pid: number | null;
  why: string;
}

/** The locks this process holds: taking one twice is refused, not mistaken for a stale lock naming this PID. */
const held = new Set<string>();

/**
 * Acquire the lock file at `path`, writing this process's PID into it, or throw when a live process holds it.
 *
 * A stale one is taken over and said so in `tookOver`: the holder is gone (a crash, a `kill -9`), the file names no
 * PID, the PID is this process's own, or it is a live process `heldBy` says is not a holder.
 */
export function acquireLockFile(path: string, options: LockOptions = {}): { release(): void; tookOver: TakenOver | null } {
  const key = resolve(path);
  if (held.has(key)) throw new Error(`another Nouride instance is running (PID ${process.pid}). Lock file: ${path}`);

  let tookOver: TakenOver | null = null;
  try {
    create(path);
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw err;
    // An unreadable lock file names no holder, so it is taken over like a dead one — through the same path, so the
    // lock it ends in is released like any other.
    let named: number | null = null;
    try {
      named = Number(readFileSync(path, "utf-8").trim());
    } catch {}
    const pid = named !== null && Number.isInteger(named) && named > 0 ? named : null;
    // Decided before throwing, not by throwing inside a try that catches itself: the control flow must never depend
    // on our own Error having no `code`.
    const why = staleBecause(pid, options);
    if (why === null) throw new Error(`another Nouride instance is running (PID ${pid}). Lock file: ${path}`);
    unlinkSync(path);
    create(path);
    tookOver = { pid, why };
  }

  held.add(key);
  return {
    tookOver,
    release() {
      held.delete(key);
      try {
        unlinkSync(path);
      } catch {}
    },
  };
}

/** Why a lock naming `pid` is stale, or null when a live process holds it. */
function staleBecause(pid: number | null, options: LockOptions): string | null {
  if (pid === null) return "it names no process";
  // Not one this process took (that is `held`), so the daemon that wrote it had this same PID and is gone.
  if (pid === process.pid) return `it names PID ${pid}, which is this process: the daemon that took it had the same PID and is gone`;
  if (!isProcessAlive(pid)) return `PID ${pid} is gone`;
  if (!options.heldBy) return null;
  const command = (options.commandLine ?? processCommandLine)(pid);
  if (command === null || options.heldBy(command)) return null;
  return `PID ${pid} is now \`${command}\`, which is not a Nouride daemon`;
}

function create(path: string): void {
  const fd = openSync(path, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
