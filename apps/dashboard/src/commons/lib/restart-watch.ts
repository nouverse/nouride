/**
 * Following a restart from the browser, one look at `/health` at a time — for Overview's Restart
 * (`restart.ts`, the one follower) and the update page's card (`modules/update/RestartingCard.tsx`) alike.
 *
 * Each had its own copy. The card's predated the daemon waiting for running work before it restarts: the old process
 * answering on the old version was "not back" to it, so after 45 s a daemon finishing a job read as one that had not
 * answered, with `systemctl status` offered as the fix. Pure, so the decision is tested as one.
 */

import type { HealthPayload } from "@nouride/wire";

/** How often to look. Often enough to feel live, rarely enough to be polite. */
export const POLL_MS = 2_000;
/** From going down to answering again: a shutdown and a boot. Longer than that, something is wrong. */
export const BOOT_PATIENCE_MS = 3 * 60_000;

/**
 * What one look at `/health` says about a restart: still the process that was asked to restart, gone for now, or a
 * new one. A new one is an uptime smaller than before, or any answer after a silence — once it has finished starting.
 * A booting daemon answers from its first second, "starting", with its routes 503 until it is done; taken for back,
 * the page reloaded every query into that.
 */
export function readRestart(health: HealthPayload | null, before: number | null, wasAway: boolean): "away" | "back" | "same" {
  if (!health || health.status === "shutting_down" || health.status === "starting") return "away";
  return wasAway || (before !== null && health.uptime < before) ? "back" : "same";
}

export interface RestartWatch {
  /** The uptime of the process asked to restart, or null when it was not answering then. */
  before: number | null;
  /** When nothing answered first, or null while something still does. */
  awaySince: number | null;
}

/**
 * - `waiting`: the process asked to restart still answers — its running work finishes first, a job however long;
 * - `restarting`: nothing answers yet, or a new process is still starting;
 * - `stuck`: nothing has answered for longer than a shutdown and a boot take;
 * - `back`: a new process answers, done starting.
 */
export type RestartPhase = "waiting" | "restarting" | "stuck" | "back";

/** The restart after one more look, at `now`. */
export function lookAgain(watch: RestartWatch, health: HealthPayload | null, now: number): { watch: RestartWatch; phase: RestartPhase } {
  const seen = readRestart(health, watch.before, watch.awaySince !== null);
  if (seen === "back") return { watch, phase: "back" };
  if (seen === "same") return { watch, phase: "waiting" };
  const awaySince = watch.awaySince ?? now;
  return { watch: { ...watch, awaySince }, phase: now - awaySince > BOOT_PATIENCE_MS ? "stuck" : "restarting" };
}

/** An update's restart: as `lookAgain`, and back on another version than the one installed is a rollback. */
export type InstallPhase = RestartPhase | "rolled-back";

/**
 * The version decides it where it can. Answering on the version installed, done starting, is back whatever the uptime
 * says — the card may first look after the restart is over. A new process on any other version means the new one did
 * not start and the one it replaced came back.
 */
export function lookAtInstall(watch: RestartWatch, health: HealthPayload | null, expected: string, now: number): { watch: RestartWatch; phase: InstallPhase } {
  if (health && health.status !== "starting" && health.status !== "shutting_down" && sameVersion(health.version, expected)) {
    return { watch, phase: "back" };
  }
  const next = lookAgain(watch, health, now);
  return next.phase === "back" ? { ...next, phase: "rolled-back" } : next;
}

/** `v0.3.2` and `0.3.2` are one version written two ways — the tag and the package's own. */
function sameVersion(running: string | undefined, expected: string): boolean {
  return Boolean(running) && running!.replace(/^v/, "") === expected.replace(/^v/, "");
}
