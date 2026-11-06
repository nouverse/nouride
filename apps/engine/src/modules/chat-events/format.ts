/**
 * The block of room events that goes in front of a question.
 *
 * In the **user message**, not the system prompt, and for the same reason `formatOverheard` is: the
 * prompt's stable prefix is what providers cache (§6.3 of `docs/SPEC.md`, and `toSystemBlocks`), and a section that
 * changes every turn would miss that cache on every turn — which costs far more than the block.
 *
 * A separate block from the overheard chatter rather than merged into it. They answer different
 * questions — *what changed about this room* and *what was said in it* — and the label on each is
 * what keeps the model from treating either as the thing it was asked. That label is not decoration:
 * `group-context.ts` records what happened without one, which is that the model answered the
 * chatter instead of the person who tagged it.
 */

import type { ChatEvent } from "./chat-events.store.ts";

/**
 * Chars the block may take.
 *
 * Smaller than the overheard block's 6000 because these lines are one sentence each and there are at
 * most ten of them. A budget that could never be reached is a budget that hides a bug the day the
 * shape changes, so it is set near what the content actually needs.
 */
const BLOCK_MAX_CHARS = 1_500;

/**
 * Compose the block, or an empty string when there is nothing to say.
 *
 * Empty is the common case and is meant to be: most turns follow another turn with nothing having
 * happened to the room in between.
 */
export function formatRoomEvents(events: ChatEvent[], budget = BLOCK_MAX_CHARS): string {
  if (events.length === 0) return "";

  const head =
    events.length === 1
      ? "[1 thing happened in this conversation since your last message: background, not something to answer]"
      : `[${events.length} things happened in this conversation since your last message: background, not something to answer]`;

  const lines: string[] = [];
  let spent = head.length;
  /**
   * Newest first, then reversed.
   *
   * The same direction `formatOverheard` spends its budget in, and for the same reason: the most
   * recent event is the one the current message is most likely about, so it is the last thing that
   * should be dropped. Reversed at the end because a reader — human or model — follows a list of
   * events forwards.
   */
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const line = `- ${oneLine(event.text)}`;
    if (spent + line.length + 1 > budget) break;
    spent += line.length + 1;
    lines.push(line);
  }

  if (lines.length === 0) return "";
  return [head, ...lines.reverse()].join("\n");
}

/**
 * One line per event, whatever the writer put in `text`.
 *
 * The block's shape is what the label describes, and a newline inside an event would break the list
 * into something that reads like a new section — which is how a background block starts looking like
 * an instruction.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
