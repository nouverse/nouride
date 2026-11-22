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

import { oneLine } from "@nouride/shared";
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
    // One line per event, whatever the writer put in `text`: a newline inside one would break the list into something
    // that reads like a new section, which is how a background block starts looking like an instruction.
    const line = `- ${oneLine(event.text)}`;
    if (spent + line.length + 1 > budget) break;
    spent += line.length + 1;
    lines.push(line);
  }

  if (lines.length === 0) return "";
  return [head, ...lines.reverse()].join("\n");
}

/** Chars the missions' block may take: a done notice carries its result, so a line is longer than a room event's. */
const MISSIONS_MAX_CHARS = 3_000;
/** Chars of one notice: its first lines say what happened, and the whole is on the mission's page. */
const NOTICE_MAX_CHARS = 700;

/**
 * What an agent's own missions told this chat since it was last spoken to, as a block in front of the question.
 *
 * The notices as the person read them, not a summary made of the missions' states: whatever a mission says to its
 * chat (it is queued, it started, how far it is, it nears a limit, it needs something, it goes on, it is done, a
 * draft changed) reaches the agent the same way, with nothing to keep in step. Of a mission's progress lines only the
 * newest is said: the chat shows one, rewritten.
 *
 * `clock` writes a notice's time as the daemon's own zone has it. Newest first within the budget, as `formatRoomEvents`.
 */
export function formatMissionNotices(events: ChatEvent[], clock: (at: number) => string, budget = MISSIONS_MAX_CHARS): string {
  const newestProgress = new Map<unknown, string>();
  for (const event of events) if (event.details?.progress === true) newestProgress.set(event.details.mission, event.id);
  const kept = events.filter((event) => event.details?.progress !== true || newestProgress.get(event.details.mission) === event.id);

  const lines: string[] = [];
  let spent = 0;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const event = kept[index]!;
    const said = oneLine(event.text);
    const line = `- ${clock(event.at)} ${said.length > NOTICE_MAX_CHARS ? `${said.slice(0, NOTICE_MAX_CHARS)}…` : said}`;
    if (lines.length > 0 && spent + line.length + 1 > budget) break;
    spent += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  const one = lines.length === 1;
  const head = `[Since your last message here, your own missions told this chat ${one ? "1 thing" : `${lines.length} things`} under your name. The person has read ${one ? "it" : "them"} and you had not: background for what they say next, not something to answer. A mission's newest line is how it stands now]`;
  return [head, ...lines.reverse()].join("\n");
}
