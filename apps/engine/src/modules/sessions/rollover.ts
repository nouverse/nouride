/**
 * Whether a conversation's context should be cleared before the incoming message joins it —
 * `[rollover]`.
 *
 * A session concern, not memory's: memory is cut from the turn log, so clearing a context loses
 * nothing. This only decides how long one context runs before it starts fresh.
 */

import type { RolloverSection } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";

/** The local hour at a moment, for the hour a `daily` rollover happens at. */
function localHour(at: number, timeZone: string): number {
  return Number(localTime(at, timeZone).time.slice(0, 2));
}

export interface RolloverDecision {
  stale: boolean;
  reason?: "daily" | "idle";
}

/**
 * Whether an existing conversation should be closed before the incoming message joins it.
 *
 * Lazy on purpose — asked when a message arrives, not driven by a timer. A conversation nobody is
 * having does not need closing on schedule.
 *
 * `daily` reads when the conversation *began*, `idle` reads when it was last touched. That
 * difference is the whole point of having two modes: a conversation someone has kept up all day is
 * still stale under `daily` at the next boundary, and one started an hour ago is not stale under
 * `idle` no matter how old the chat is.
 */
export function evaluateRollover(params: {
  startedAt: number;
  updatedAt: number;
  now: number;
  rollover: RolloverSection;
  timezone: string;
}): RolloverDecision {
  const { rollover } = params;
  if (rollover.mode === "none") return { stale: false };

  if (rollover.mode === "idle") {
    if (rollover.idleMinutes <= 0) return { stale: false };
    const expiresAt = params.updatedAt + rollover.idleMinutes * 60_000;
    return params.now > expiresAt ? { stale: true, reason: "idle" } : { stale: false };
  }

  const boundary = lastDailyBoundary(params.now, rollover.atHour, safeTimeZone(params.timezone));
  return params.startedAt < boundary ? { stale: true, reason: "daily" } : { stale: false };
}

/**
 * The most recent `atHour` boundary at or before `now`, as a timestamp.
 *
 * Derived by walking back from `now` in hours rather than by constructing a local date: the offset
 * of a timezone is not a constant, and building "today at 04:00" from parts means reimplementing DST
 * — which is how a boundary ends up an hour off twice a year in the places that observe it.
 */
function lastDailyBoundary(now: number, atHour: number, timeZone: string): number {
  // 48 hours of slack covers any offset shift; a boundary further back than that would mean the
  // clock moved, not that the hour was missed.
  for (let back = 0; back < 48; back += 1) {
    const candidate = now - back * 3_600_000;
    if (localHour(candidate, timeZone) === atHour) {
      // Truncate to the top of that local hour, so a conversation started at 04:30 is not treated as
      // having begun before the 04:00 boundary it actually followed.
      return candidate - remainderWithinHour(candidate, timeZone);
    }
  }
  return now;
}

/** Milliseconds elapsed since the top of the local hour containing `at`. */
function remainderWithinHour(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return get("minute") * 60_000 + get("second") * 1000 + (at % 1000);
}
