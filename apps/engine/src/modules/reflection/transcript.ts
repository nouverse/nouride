/**
 * A conversation as the reflection pass reads it: flattened, budgeted so the whole of it is visible, and scrubbed of
 * credentials on the way out. One path from a turn to a transcript, so none can be built that skips the scrub. Out of
 * `synthesis.ts`, which asks the model and reads its answers.
 */

import { keepEnds, messageText, type ChatMessage } from "@nouride/shared";
import { redact } from "@nouride/secrets";

/**
 * Characters of transcript the pass reads.
 *
 * Raised from 24,000, which was too small for the trigger that fires most often. Watched live: a
 * 22-turn session scaffolding a video project ran 35,680 characters of prompts and replies **before
 * counting a single tool result**, and one of its turns made 25 tool calls. `sustained_effort` fires
 * *because* the conversation was long, and then showed triage only its last third — so the eight
 * turns where the work was decided and the failures happened were invisible, and the pass declined
 * eight times describing the tail as routine.
 *
 * One triage call at this size is roughly 15k tokens, against agent turns on the same box measured
 * at 53k-110k input. The pass reading less than the agent did is the wrong economy.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;

/** One recent tool result, before the transcript is budgeted. A 200KB log teaches nothing extra. */
const MAX_MESSAGE_CHARS = 2_000;

/**
 * The floor for an older message, so the whole arc survives instead of its last fifth.
 *
 * The head used to be dropped outright, and that is the wrong half to lose: "this failed, then this
 * failed, then *this* worked" is the shape of a lesson. Cutting the head leaves only the part where
 * everything already works, which reads as routine and gets skipped.
 */
const MIN_MESSAGE_CHARS = 320;

/** Messages kept at full width. Older ones are compressed rather than dropped. */
const FULL_WIDTH_MESSAGES = 24;

/**
 * The turn, flattened into something a model can read — and scrubbed on the way out.
 *
 * Redaction happens here rather than at the call site so there is exactly one path from a turn to a
 * transcript, and it is not possible to build one that skips it. The same string is what gets stored
 * on the draft, so what the reviewer inspects is what the model was shown.
 *
 * Long tool results are cut in the middle rather than at the end: an error message is usually at the
 * top of a failing command's output and the recovery at the bottom, and keeping only the head loses
 * the half the reflection is about.
 *
 * The conversation is budgeted so the whole of it is visible.
 *
 * Recent messages keep their full width; older ones are compressed to fit, and dropped only when
 * even the floor will not. That ordering is the point: the tail holds the method that finally
 * worked, the head holds the failures that make it worth writing down, and losing either leaves the
 * pass reading a different conversation from the one that happened.
 *
 * No attempt is made to *find* the failures and keep those. That needs a guess about what a failure
 * looks like in free text, and a wrong guess quietly changes what the pass sees — the trap a
 * language check for skills already fell into once. Compressing evenly needs no such guess.
 */
export function buildTranscript(messages: ChatMessage[]): { text: string; redactions: string[] } {
  const label = (message: ChatMessage) => (message.role === "tool" ? "tool result" : message.role);
  /** The blank line between entries, plus the label and its colon. */
  const overhead = (message: ChatMessage) => label(message).length + 4;

  const recentFrom = Math.max(0, messages.length - FULL_WIDTH_MESSAGES);
  const recent = messages.slice(recentFrom);
  const older = messages.slice(0, recentFrom);

  const spend = (list: ChatMessage[], width: number) =>
    list.reduce((total, m) => total + Math.min(m.content.length, width) + overhead(m), 0);

  /**
   * What the older half may spend, once the recent half has taken what it needs.
   *
   * The recent half is never squeezed to make room for the older one: a lesson is written from the
   * method that worked, and that is at the end.
   */
  const budget = MAX_TRANSCRIPT_CHARS - spend(recent, MAX_MESSAGE_CHARS);
  let kept = older;
  let width = MAX_MESSAGE_CHARS;

  if (budget <= 0) {
    kept = [];
  } else {
    // Widest that fits, down to the floor. Halved rather than solved for: the content lengths are
    // arbitrary, so this converges in a few steps and needs no arithmetic anybody has to trust.
    while (width > MIN_MESSAGE_CHARS && spend(kept, width) > budget) width = Math.floor(width / 2);
    width = Math.max(width, MIN_MESSAGE_CHARS);
    // Still over at the floor: drop from the oldest end, the only end that can go.
    while (kept.length > 0 && spend(kept, width) > budget) kept = kept.slice(1);
  }

  const dropped = older.length - kept.length;
  const lines = [
    ...(dropped > 0 ? [`[${dropped} earlier message(s) dropped for length]`] : []),
    ...kept.map((m) => `${label(m)}: ${keepEnds(messageText(m.content), width, CUT)}`),
    ...recent.map((m) => `${label(m)}: ${keepEnds(messageText(m.content), MAX_MESSAGE_CHARS, CUT)}`),
  ];

  const scrubbed = redact(lines.join("\n\n"));
  return { text: scrubbed.text, redactions: scrubbed.hits };
}

/** The line where a message's middle was cut. */
const CUT = (left: number) => `…[${left} characters cut]…`;
