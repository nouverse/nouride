/**
 * When the pass looks, and how often — its own dials, not the operator's.
 *
 * Until 0.7.27 these were `[rsi]` settings beside the mode. Nobody tuned them to a purpose: the one box that changed
 * two of them did so while chasing cost, and the dial that bounds cost is the cooldown, not the threshold (measured
 * below). Five numbers an operator has to understand before they can leave them alone was the wrong trade, so they
 * are fixed here, at the defaults they had, and a test can still set them (`ReflectionDeps.tuning`).
 */

export interface Tuning {
  /**
   * Tool failures in one turn before a recovery counts as something worth writing down.
   *
   * One failure is a typo; several followed by a success is a procedure somebody had to work out.
   */
  minToolFailures: number;
  /**
   * Model round-trips in one conversation before the pass stops to consider what it learned.
   *
   * Hermes' unit: a turn is at least one round and gains one for every round of tool use. It catches what a failure
   * count cannot see — a long conversation where every command succeeded and the person still had to steer. Measured
   * over 332 real turns, the *number* of reflections barely moves with this dial (31 at 6, 30 at 10, 28 at 16)
   * because the cooldown bounds the cost, so it buys latency, not volume. Borrowed from Hermes Agent's
   * `skill_nudge_interval`, whose 10 counts tool iterations only.
   */
  reflectAfter: number;
  /**
   * A reply arriving inside this window makes the turn count for one extra round.
   *
   * Correction density counted without reading a word: ten exchanges in fifteen minutes is somebody steering. Measured
   * from the moment the agent finished to the next message, so it is the *person's* latency. Over 228 real turns three
   * minutes left the number of reflections unchanged while a dense chain reached the threshold in six turns, not ten.
   */
  rapidFollowUpMs: number;
  /**
   * Minimum gap between two automatic passes from the same agent, timed from the last time it *looked*; a person
   * asking for a skill ignores it.
   *
   * A minute — near enough to off, and deliberately. It was an hour, so that an afternoon on one broken system yielded
   * one draft rather than a dozen, and that was the wrong trade: Hermes has no wall-clock cooldown at all, what
   * throttles its pass is *work done*, which `reflectAfter` measures here, and the flood it guarded against is what
   * supersession by name and `maxPending` handle by looking at the drafts. Measured on the live box: 50 passes over two
   * days, five drafts. Not zero, because a pass still costs a call and two turns in the same second are one
   * conversation.
   */
  cooldownMs: number;
  /** Pending drafts before the pass stops proposing: a backlog nobody clears is a reason to stop generating. */
  maxPending: number;
}

export const TUNING: Tuning = {
  minToolFailures: 3,
  // Eight: five turns of a dense back-and-forth, eight of a leisurely one; Hermes' 10 counts tool rounds only.
  reflectAfter: 8,
  rapidFollowUpMs: 3 * 60_000,
  cooldownMs: 60_000,
  maxPending: 20,
};
