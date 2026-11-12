/**
 * Room made inside a turn that is still running, when its own steps fill the window.
 *
 * Old tool output is set aside and old writes are shortened as a turn goes, with no model call (`trimToolResults`).
 * That clears what the steps carried, not the steps: a turn of several hundred calls is still several hundred calls
 * and their markers, and once those alone passed the window the turn ended on an overflow that leaving out earlier
 * turns could not clear, because the running turn is the one thing that net keeps whole.
 *
 * So the turn's oldest steps are summed up, by the summarizer a conversation's history is summed up by, and the turn
 * goes on from its notes and its newest steps. A step is a reply of the model's and whatever answered it, so a call
 * and its result leave together or stay together. The notes are put at the head of the oldest reply kept, never as a
 * message of their own: two messages of one role in a row are refused by some providers.
 */

import { estimateMessagesTokens } from "@nouride/llm";
import { createLogger, messageText, type ChatMessage } from "@nouride/shared";
import { summarizeSpan, type CompactOptions } from "./summarize.ts";

const log = createLogger("llm.summarize");

/** What stands in front of the notes, so the model reads them as its own record and not as something said to it. */
export const STEPS_NOTE =
  "[My notes on the earlier steps of this turn. They left my context to make room, so these notes are what I have of" +
  " them: what they did is done, and the steps after this are the newest.]";

/** The least the steps that would leave must weigh, as a share of the room, for notes on them to be worth a call. */
const WORTH_SHARE = 0.25;

export interface StepsRoom {
  /** The working set with the oldest steps as notes. The messages before the turn's own are as they were. */
  messages: ChatMessage[];
  /** How many steps the notes stand for. */
  steps: number;
  tokens: number;
}

export interface StepsOptions extends Pick<CompactOptions, "provider" | "model" | "summarizerWindow" | "signal"> {
  /** The line the working set has to pass before any step is summed up, in the estimator's tokens. */
  startTokens: number;
  /** What it should fit once they are: lower than the line, so a turn is not asked for notes round after round. */
  fitTokens: number;
  onStart?: (info: { steps: number; tokens: number }) => void;
}

/**
 * The turn's steps, oldest first: each a reply of the model's and what follows it up to the next. Null where the
 * turn's own messages do not start with one, which is no shape this knows how to cut.
 */
function stepsOf(own: ChatMessage[]): ChatMessage[][] | null {
  if (own.length > 0 && own[0]!.role !== "assistant") return null;
  const steps: ChatMessage[][] = [];
  for (const message of own) {
    if (message.role === "assistant") steps.push([message]);
    else steps.at(-1)!.push(message);
  }
  return steps;
}

/**
 * Sum up the oldest steps of the turn that begins at `turnStart` (the count of messages before its own), keeping the
 * newest that fit. Null when there is nothing to gain: the working set under its line, one step alone, steps too
 * small to be what fills the window, or notes no smaller than what they would stand for. Throws what the summarizer
 * throws.
 */
export async function sumUpOldSteps(working: ChatMessage[], turnStart: number, options: StepsOptions): Promise<StepsRoom | null> {
  const before = estimateMessagesTokens(working);
  // Under the line that starts it, the turn goes on as it is: room is made down to `fitTokens` once it is passed, and
  // the stretch between the two is what the turn works in before it is asked for again.
  if (before <= options.startTokens) return null;
  const head = working.slice(0, turnStart);
  const steps = stepsOf(working.slice(turnStart));
  if (!steps) return null;

  // The newest steps, whole, while they fit beside what came before the turn: at least the last one, whose results
  // the model has not read yet.
  const room = options.fitTokens - estimateMessagesTokens(head);
  let kept = 0;
  let keptTokens = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const tokens = estimateMessagesTokens(steps[index]!);
    if (kept > 0 && keptTokens + tokens > room) break;
    keptTokens += tokens;
    kept += 1;
  }
  const cut = steps.length - kept;
  if (cut < 1) return null;
  // Worth a model call only where the steps are what fills the window. Where it is what came before the turn, a
  // step or two would be summed up before every request and the request would be as full as it was.
  if (estimateMessagesTokens(steps.slice(0, cut).flat()) < options.fitTokens * WORTH_SHARE) return null;

  const asked = head.at(-1);
  // What the turn was asked, in front of its steps, so the notes say what the work was for.
  const span = [...(asked?.role === "user" ? [asked] : []), ...steps.slice(0, cut).flat()];
  options.onStart?.({ steps: cut, tokens: before });
  const parts = await summarizeSpan(span, undefined, 1, options);
  const notes = `${STEPS_NOTE}\n\n${parts.map((part) => part.text).join("\n\n")}`;

  const [oldest, ...after] = steps.slice(cut).flat() as [ChatMessage, ...ChatMessage[]];
  const said = messageText(oldest.content);
  const messages = [...head, { ...oldest, content: said ? `${notes}\n\n${said}` : notes }, ...after];
  const tokens = estimateMessagesTokens(messages);
  if (tokens >= before) {
    log.info("notes on a turn's steps no smaller than the steps: kept as they were", { steps: cut, before, after: tokens });
    return null;
  }
  log.info("a running turn's oldest steps summed up", { steps: cut, kept, before, after: tokens });
  return { messages, steps: cut, tokens };
}
