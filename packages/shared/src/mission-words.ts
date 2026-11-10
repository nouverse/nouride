/** A mission's time and turns in the words its page, `show`, `work` and `nouride mission` all use. */

import { plural } from "./text.ts";

/** Time worked, as the page writes it: `8h58m`, `45m`. */
export function hoursAndMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * A limit in hours, written as the page writes time worked: `8h`, `8h58m`, `45m`. Printed as it was kept, one raised from
 * where a mission stood read "of 8.960713333333333h" (msn_3d28e0, 0.8.8).
 */
export function hoursLimit(limit: number): string {
  const minutes = Math.round(limit * 60);
  return minutes % 60 === 0 ? `${minutes / 60}h` : hoursAndMinutes(minutes * 60_000);
}

/**
 * Its turns against its limit, as the page, `show` and `work` say them — and `nouride mission show`. An ended mission none
 * of whose turns finished — stopped in the first, or a draft dropped — read "0 turns ran", and the CLI
 * "turn 0 of 100".
 */
export function turnsSaid(mission: { turnsUsed: number; limits: { turns: number }; startedAt: number | null; endedAt: number | null }, limited = true): string {
  const none = mission.endedAt !== null && mission.turnsUsed === 0;
  const count = mission.endedAt === null ? `turn ${mission.turnsUsed + 1}` : none ? (mission.startedAt === null ? "ended before it started" : "ended before a turn finished") : `${mission.turnsUsed} ${plural(mission.turnsUsed, "turn")} ran`;
  return !limited ? `${count} (a coding CLI's: turns not limited)` : none ? `${count} (at most ${mission.limits.turns} turns)` : `${count} of at most ${mission.limits.turns}`;
}
