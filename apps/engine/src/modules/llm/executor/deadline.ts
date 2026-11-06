/**
 * When a turn should stop working and start answering.
 *
 * The loop already had two ways to end — the iteration cap and the abort signal — and only the
 * first of them ends with a reply. The cap calls `wrapUp`, which asks the model for one last
 * message; the signal fires in the middle of a tool call, the loop breaks with no text, and the
 * pipeline says "I ran out of time on that one and stopped part-way".
 *
 * Observed live: a turn spent 300s watching a CI run, 21 tool calls, every one of them successful.
 * It had merged the pull request, re-pushed the tag, re-run the failed job and diagnosed the flake.
 * The person was told none of it, because the clock stopped the turn a round before the model would
 * have spoken. The iteration cap would have rescued the same turn four rounds later.
 *
 * So the deadline gets the treatment the cap already has: leave enough of it to say something.
 */

/**
 * How much of the turn is held back for the closing reply.
 *
 * A share rather than a constant, because `max_turn_duration_ms` is the operator's to set and a
 * fixed 45s is most of a 60s turn and a rounding error on a 30-minute one. Clamped at both ends: a
 * provider needs a handful of seconds to answer at all, and past a minute the reserve is just budget
 * nobody spends.
 */
const WRAP_UP_RESERVE_SHARE = 0.15;
const MIN_RESERVE_MS = 20_000;
const MAX_RESERVE_MS = 60_000;

export function wrapUpReserveMs(maxTurnDurationMs: number): number {
  const share = Math.round(maxTurnDurationMs * WRAP_UP_RESERVE_SHARE);
  return Math.min(MAX_RESERVE_MS, Math.max(MIN_RESERVE_MS, share));
}

/**
 * Is there still room for another tool round, or only for the reply?
 *
 * Answered before the round starts, which is the only place it can be answered honestly — a tool
 * call that has begun cannot be shortened, and the foreground timeout (30s by default) is itself
 * most of the reserve.
 *
 * Unknown deadline means no: `deadlineAt` is optional on the request and a caller that does not set
 * one has no timer to run out of, so inventing a limit for it would end turns early for free.
 */
export function outOfTimeForAnotherRound(input: {
  deadlineAt?: number;
  maxTurnDurationMs: number;
  now: number;
}): boolean {
  if (input.deadlineAt === undefined) return false;
  return input.deadlineAt - input.now <= wrapUpReserveMs(input.maxTurnDurationMs);
}
