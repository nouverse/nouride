/**
 * What a turn adds to the message it answers: the clock, and the reminders for this turn.
 *
 * ## Kept as sent (M1, 2026-10-15)
 *
 * The message went to the model with its notes and was stored without them, on the reasoning that a
 * note in the transcript is a line the person never wrote, "filed every night and found by every
 * search". What that cost was the prompt cache. Turn N's request ends `…, user_N + notes`; turn N+1
 * sends `…, user_N, assistant_N, …` — so the cached prefix stopped at `user_N`, and everything turn N
 * added was written to the cache again (at 1.25×) on the next turn. Implicit prefix caches — OpenAI,
 * Gemini through Nougate — broke at the same byte.
 *
 * And the reasoning had stopped holding. The nightly pass files conversations from the turn records,
 * which keep what the person typed (`memory/cut.ts`), not from the session; the one place a person
 * reads the session itself — the dashboard's transcript of history older than its turn records — takes
 * the notes off with `withoutReminders`. What the model now has in its history is when each message was
 * sent, which it did not know before.
 */

import type { ChatMessage, MessageContent } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";

/**
 * The time, on the message being answered rather than in the system prompt.
 *
 * In the prompt it was `Current time: <ISO, to the millisecond>`, which every request changes — and a
 * prefix cache stops at the first byte that changed, so nothing after it, the whole conversation
 * included, was ever read back from cache on the next turn. The prompt now carries only the date.
 */
export function clockNote(at: Date, timeZone: string): string {
  const zone = safeTimeZone(timeZone);
  const local = localTime(at.getTime(), zone);
  return `(Sent ${local.day} ${local.time} ${zone}.)`;
}

/**
 * The user message as sent: with this turn's reminders at the end, where they are read last.
 *
 * A copy — the caller's message is left as it was. The clock note is always the first of them, which
 * is how `withoutReminders` finds where they begin.
 */
export function withReminders(message: ChatMessage, reminders: string[] | undefined): ChatMessage {
  if (!reminders?.length) return message;
  const note = reminders.join("\n\n");
  const content: MessageContent =
    typeof message.content === "string"
      ? `${message.content}\n\n${note}`
      : [...message.content, { type: "text", text: note }];
  return { ...message, content };
}

/** `clockNote`'s shape, and nothing a person is likely to type: a date, a time and a zone in parentheses. */
const CLOCK_NOTE = /\(Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s)]+\.\)/;

/**
 * The message as it was written, for a person reading it: what `withReminders` added, taken off again.
 *
 * Everything from the last clock note on — the last, so a person who pasted an earlier note into their
 * own message keeps their words. A message that carries none comes back unchanged.
 */
export function withoutReminders(message: ChatMessage): ChatMessage {
  if (typeof message.content === "string") {
    const notes = [...message.content.matchAll(new RegExp(`\\n\\n${CLOCK_NOTE.source}`, "g"))];
    const at = notes.at(-1)?.index;
    return at === undefined ? message : { ...message, content: message.content.slice(0, at) };
  }
  if (!Array.isArray(message.content)) return message;
  const last = message.content.at(-1);
  const added = last?.type === "text" && new RegExp(`^${CLOCK_NOTE.source}`).test(last.text);
  return added ? { ...message, content: message.content.slice(0, -1) } : message;
}
