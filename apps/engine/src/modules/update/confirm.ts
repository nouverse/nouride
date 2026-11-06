/**
 * An update is not done when the files are swapped. It is done when the new version has proved it
 * works — and until then, the previous one is one step away.
 *
 * A box that fails to come back on a new version must return to the old one by itself, because a box
 * that needs collecting to be fixed is the failure the whole release channel exists to prevent. Two
 * halves, because a new binary cannot be trusted to rescue itself:
 *
 * - **Outside the binary**, the unit's `ExecStartPre` guard (`service/unit.ts`). It runs before every
 *   start while an update is unconfirmed, counts the starts, and on the fourth restores
 *   `.nouride-previous`. A binary that crashes at once, or does not even exec, is caught here.
 * - **Inside it**, {@link watchPendingUpdate}: the new version confirms itself once it is healthy,
 *   which removes the marker the guard counts. One that runs but never becomes healthy in
 *   {@link CONFIRM_WITHIN_MS} marks itself failed and exits, and the guard restores on the next start.
 *
 * Whichever version runs afterwards reports what happened, so the fleet view knows.
 */

import { contained, createLogger } from "@nouride/shared";
import { join, readTextFileSync, removePath, setFileMode, writeBytesSync } from "@nouride/runtime";
import { GUARD_STARTS, PENDING_FILE, ROLLED_BACK_FILE } from "@/service/update-guard.ts";

const log = createLogger("update.confirm");

/** How long a new version has to become healthy before it gives up on itself. */
export const CONFIRM_WITHIN_MS = 10 * 60_000;
/** Up this long with nothing to handle is proof enough on a quiet install. */
const QUIET_PROOF_MS = 5 * 60_000;

/**
 * Proof of life for a new version where no box service vouches for it (D7). It was `() => true`, so an update
 * confirmed itself at the first look, fifteen seconds into a boot it might not survive, and the guard's way back
 * was gone. Now: past boot; a chat gateway connected, when there are any; and a message handled since it started,
 * or five minutes up on an install that had none to handle. What a provider is doing is not asked — an outage
 * elsewhere is no reason to throw away a build that works.
 */
export function provedHealthy(seen: { status: string; gateways: readonly string[]; handled: number; upMs: number }): boolean {
  if (seen.status === "starting" || seen.status === "shutting_down") return false;
  if (seen.gateways.length > 0 && !seen.gateways.includes("connected")) return false;
  return seen.handled > 0 || seen.upMs >= QUIET_PROOF_MS;
}
const POLL_MS = 15_000;

/**
 * A marker, as far as it reads. `markPendingUpdate` writes both versions; a write cut short — a crash, a full disk — or
 * a hand edit can leave either out, or the file unreadable, and each half then means something definite (`watch`).
 */
interface Pending {
  /** What the update replaced — only ever a description. */
  from: string | null;
  /** The update. */
  to: string | null;
  at: string;
  /** The file as it was, for the log when a half of it is missing. */
  held: string;
}

const bare = (version: string) => version.replace(/^v/, "");

/**
 * The release this install last rolled back from, kept beside the binary.
 *
 * So an automatic update does not install it again: the rollback restarts the daemon, and a nightly
 * schedule that remembered nothing would take the same broken build twenty minutes later, and again
 * after that. A person can still install it on purpose; only the automatic path reads this.
 */
const ROLLED_BACK_FROM_FILE = ".nouride-rolled-back-from";

export function rolledBackFrom(installDir: string): string | null {
  try {
    const tag = readTextFileSync(join(installDir, ROLLED_BACK_FROM_FILE)).trim();
    return tag ? `v${bare(tag)}` : null;
  } catch {
    return null;
  }
}

/** Kept beside the binary, so an automatic update does not take `version` again — `rolledBackFrom`. */
export function rememberRollback(installDir: string, version: string): void {
  writeText(join(installDir, ROLLED_BACK_FROM_FILE), `v${bare(version)}\n`);
}
const writeText = (path: string, text: string) => writeBytesSync(path, new TextEncoder().encode(text));

/** Called by the install, after the swap and before the restart. */
export function markPendingUpdate(installDir: string, update: { from: string; to: string }): void {
  const pending = { from: bare(update.from), to: bare(update.to), at: new Date().toISOString() };
  const path = join(installDir, PENDING_FILE);
  writeText(path, `${JSON.stringify(pending)}\n`);
  setFileMode(path, 0o600);
  removePath(`${path}.attempts`);
}

/**
 * The marker at `path`, or null when there is none. One that is there is never read as none: the guard counts every
 * start while the file exists, whatever it holds, so a half-written marker taken for no marker was left for it to
 * count down to restoring a version nobody chose.
 */
function read(path: string): Pending | null {
  let held: string;
  try {
    held = readTextFileSync(path);
  } catch {
    return null;
  }
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(held);
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch {
    // Cut off mid-write: neither half can be trusted, so neither is read.
  }
  const version = (field: unknown) => (typeof field === "string" && field.trim() ? bare(field.trim()) : null);
  return { from: version(value.from), to: version(value.to), at: String(value.at ?? ""), held: held.slice(0, 160) };
}

export interface UpdateReport {
  tag: string;
  outcome: "installed" | "rolled_back";
  reason?: string;
}

export interface ConfirmDeps {
  installDir: string;
  /** What this process runs. */
  version: string;
  /** Whether this version has proved it works — ready, and on a box one successful sync. */
  healthy(): boolean | Promise<boolean>;
  /** Tell the fleet. Best effort: a report that cannot be sent never blocks a confirmation. */
  report?(report: UpdateReport): Promise<void>;
  requestRestart(reason: string): void;
  /**
   * After the update has confirmed itself: the moment the new version has proved it runs, which is when a privileged
   * install rewrites its unit for it (`service/drift.ts`). Best effort — a failure here never undoes a confirmation.
   */
  onConfirmed?(): Promise<unknown>;
  /** Registered so shutdown clears them. */
  timers: ReturnType<typeof setInterval>[];
  now?: () => number;
  /** Tests only: how often to look. */
  pollMs?: number;
}

/**
 * Run once, after the daemon is ready. Reports a rollback the guard performed, and confirms — or
 * gives up on — an update this process is the new version of.
 */
export function watchPendingUpdate(deps: ConfirmDeps): void {
  const now = deps.now ?? Date.now;
  const report = (r: UpdateReport) => void deps.report?.(r).catch(() => undefined);

  const running = bare(deps.version);
  const rolledBack = read(join(deps.installDir, ROLLED_BACK_FILE));
  if (rolledBack) {
    removePath(join(deps.installDir, ROLLED_BACK_FILE));
    if (rolledBack.to) {
      // What it was back on is what runs now — said from the marker when it says.
      const back = rolledBack.from ?? running;
      log.warn("an update did not start and was rolled back", { from: back, to: rolledBack.to });
      rememberRollback(deps.installDir, rolledBack.to);
      report({ tag: `v${rolledBack.to}`, outcome: "rolled_back", reason: `v${rolledBack.to} did not start; back on v${back}` });
    } else {
      // Nothing names the version that failed, so there is nothing to remember, or to tell the fleet.
      log.warn("the guard restored the previous version, and its marker does not say which update failed", { running, held: rolledBack.held });
    }
  }

  const pendingPath = join(deps.installDir, PENDING_FILE);
  const marked = read(pendingPath);
  if (!marked) return;

  /**
   * A half-written marker, read as far as it goes (`confirm-marker-half-written`). `to` is the update; `from` only says
   * what it replaced. Without `to` the update is the version running — the marker exists only between a swap and the
   * new version proving itself, and the guard let this one start — so it is watched as that, and the guard's way back
   * stays. The one half marker that is plainly over: no `to`, and `from` is what runs. The update did not take.
   */
  if (!marked.to || !marked.from) {
    log.warn("the pending-update marker is half-written: read as far as it goes", { from: marked.from ?? "unknown", to: marked.to ?? `${running} (running)`, held: marked.held });
  }
  if (!marked.to && marked.from === running) {
    removePath(pendingPath);
    removePath(`${pendingPath}.attempts`);
    log.warn("an update is half-marked and the version it replaced is the one running: it did not take", { running });
    return;
  }
  const pending = { from: marked.from ?? "an earlier version", to: marked.to ?? running };

  // Not the version the marker is for: the previous one is running (put back by hand, or by a unit
  // without the guard). The update did not take; say so and stop counting.
  if (running !== pending.to) {
    removePath(pendingPath);
    removePath(`${pendingPath}.attempts`);
    log.warn("an update is marked but this is not the version it installed", { running: deps.version, marked: pending.to });
    rememberRollback(deps.installDir, pending.to);
    report({ tag: `v${pending.to}`, outcome: "rolled_back", reason: `running v${running} instead` });
    return;
  }

  const started = now();
  const timer = setInterval(
    // A poll that fails — the marker unwritable, say — is logged, and the next poll looks again.
    contained(log, "could not confirm or give up on this update", async () => {
      // A check that throws is no proof of health either: counted as not healthy yet, so the window still ends. Thrown
      // out of the timer every poll, the update was neither confirmed nor given up on, for good.
      const healthy = await Promise.resolve()
        .then(() => deps.healthy())
        .catch((err: unknown) => {
          log.warn("could not tell whether this update is healthy", { to: pending.to, error: String(err) });
          return false;
        });
      if (healthy) {
        clearInterval(timer);
        removePath(pendingPath);
        removePath(`${pendingPath}.attempts`);
        log.info("update confirmed", { from: pending.from, to: pending.to });
        report({ tag: `v${pending.to}`, outcome: "installed" });
        await deps.onConfirmed?.().catch((err: unknown) => log.warn("after the confirmation", { error: String(err) }));
        return;
      }
      if (now() - started < CONFIRM_WITHIN_MS) return;
      clearInterval(timer);
      // Past every start the guard allows, so the next start restores the previous version.
      writeText(`${pendingPath}.attempts`, `${GUARD_STARTS + 99}\n`);
      log.error("the update never became healthy: restarting into the previous version", { to: pending.to });
      deps.requestRestart(`v${pending.to} did not become healthy`);
    }),
    deps.pollMs ?? POLL_MS,
  );
  timer.unref?.();
  deps.timers.push(timer);
}
