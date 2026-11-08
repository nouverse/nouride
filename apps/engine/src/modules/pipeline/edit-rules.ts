/**
 * What a person's edit is, decided from the envelope alone (G11): whether a message is one, what a reply to it quotes,
 * whether it changed anything a person can see, whether it is recent enough to answer again, and the words the agent
 * is told about it. Where the message edited is — and so what its edit does — is `edits.ts`.
 *
 * Nothing here knows a platform. An adapter reports an edit as an envelope carrying `edit` (`MessageEnvelope.edit`);
 * how Telegram, Discord and WhatsApp each say one happened stops in their adapters.
 */

import type { MessageEnvelope } from "@nouride/shared";
import type { TurnCause } from "@nouride/wire";
import { EDITED } from "@/modules/turns/turns.store.ts";
import { INBOX_FRESH_MS } from "./inbox.store.ts";

/**
 * How recently the edited message must have been sent for its edit to start a turn of its own: a quarter of an hour.
 *
 * The inbox's own measure (`INBOX_FRESH_MS`): a message older than that is not answered when it arrives — it gets the
 * notice that it came while the daemon was offline — and an edit of one is no fresher a question. It is WhatsApp's own
 * limit on editing too, the window a messenger chose for "correcting what I just said". Telegram allows an edit for two
 * days and Discord for ever, and people tidy a typo in an old message without asking anything again; the conversation's
 * idle window, hours long, would answer every one of those. Measured from when the message was sent — the platform's
 * own fact, still known after a restart — not from when its answer ended.
 *
 * Only for an edit whose message's turn has ended. One still waiting is answered as corrected, and one a turn is at
 * work on reaches it whenever it comes: the turn is running now.
 */
export const EDIT_WINDOW_MS = INBOX_FRESH_MS;

/** An edit as an adapter reports one — not a waiting message the engine marked as corrected, whose `edit.of` is its own id. */
export function isEdit(envelope: Pick<MessageEnvelope, "id" | "edit">): boolean {
  return envelope.edit !== undefined && envelope.edit.of !== envelope.id;
}

/** What a reply quotes: for an edit, the message edited — what the person sees, as it now reads. The edit has no message of its own. */
export function quotedId(envelope: Pick<MessageEnvelope, "id" | "edit">): string {
  return envelope.edit?.of ?? envelope.id;
}

/** What a turn answering an edit records as its cause: the message edited — `turn.editOf` on its start (stream 1.3). */
export function editCause(envelope: Pick<MessageEnvelope, "edit">): TurnCause | undefined {
  return envelope.edit ? { via: EDITED, of: envelope.edit.of } : undefined;
}

/**
 * Nothing visible changed. Telegram sends a message again when its link preview loads and Discord when its embed does,
 * each as an edit with the same words; and a run of spaces or a line break is not something anybody is asking about.
 */
export function sameWords(before: string, after: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return flat(before) === flat(after);
}

/**
 * Recent enough to answer again: sent within `EDIT_WINDOW_MS` of the edit. Where neither the platform nor the inbox says
 * when it was sent, the platform's word that it may still be edited is taken — WhatsApp allows it for fifteen minutes.
 */
export function recentEdit(sentAt: number | undefined, editedAt: number): boolean {
  return sentAt === undefined || editedAt - sentAt <= EDIT_WINDOW_MS;
}

/**
 * A waiting message, rewritten to what its edit says — in place, because the queue, the media batcher, a turn's unread
 * messages and the inbox desk each know a message by this object, and a copy would be a second message to them. Marked
 * edited, with `of` its own id, so the turn that answers it says it answered an edit.
 */
export function reviseWaiting(waiting: MessageEnvelope, edit: MessageEnvelope): void {
  const was = waiting.edit?.was ?? waiting.text;
  waiting.text = edit.text;
  if (edit.mentions) waiting.mentions = edit.mentions;
  else delete waiting.mentions;
  if (edit.mentionsSelf) waiting.mentionsSelf = true;
  else delete waiting.mentionsSelf;
  waiting.edit = { of: waiting.id, was };
}

/** What the message said before, short and on one line, for the line that frames its edit. */
function before(was: string | undefined): string {
  const flat = (was ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

/**
 * The line in front of an edit a running turn reads (`steering.ts`). `own`: the turn is working on the message edited —
 * its question, or a message it read as it worked — so the edit is a correction to go by. Otherwise an earlier message
 * changed, which may or may not matter to what it is doing.
 */
export function steerEditHeader(who: string, edit: MessageEnvelope, own: boolean): string {
  const was = before(edit.edit?.was);
  return own
    ? `${who} edited the message you are working on${was ? ` (it said: "${was}")` : ""}. It now reads as below. Go by this, not by what they first wrote.`
    : `${who} edited a message they sent earlier${was ? ` (it said: "${was}")` : ""}. It now reads as below. Read it before your next step: it may change what you are doing.`;
}

/**
 * The line in front of an edit that starts a turn of its own: the message was answered already, and the agent is asked
 * the edited one — so it can say what changes. No name: a one-to-one chat gives the model none it did not verify.
 */
export function editedQuestionNote(edit: MessageEnvelope): string {
  const was = before(edit.edit?.was);
  return (
    `[This is an edit: they changed a message they sent earlier${was ? ` (it said: "${was}")` : ""}, and it now reads as below. ` +
    "Answer it as it reads now, and say what changes from what you said before, if anything does.]"
  );
}

/** The line a turn's record draws for an edit it read, marked for a reader that knows no `editOf` (stream 1.3). */
export function editLine(text: string): string {
  return `✎ ${text}`;
}
