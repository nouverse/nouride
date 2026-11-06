/**
 * A person's edit of a message they sent, as it arrives (G11): where the message edited is decides what the edit does.
 *
 * - **Still waiting** for its turn — in the queue, the media batcher, or a running turn's messages not yet read: its text
 *   is replaced, and the agent answers the corrected message once.
 * - **A turn is at work on it** — the turn's own question, or a message it read as it worked: the edit reaches that turn
 *   the way a message sent mid-turn does (`steering.ts`), framed as the person's correction.
 * - **Its turn has ended**: the edit goes on as a message of its own, framed as an edit so the agent can say what
 *   changes (`edit-rules.ts`) — only while recent (`EDIT_WINDOW_MS`).
 *
 * An edit that changes nothing visible does none of these: Telegram sends a message again when its link preview loads,
 * and Discord when its embed does. Nor does one that now reads as a command: an edit is words. In a room, routing then
 * decides as for any message (`inbound.ts`): an edit that now addresses an agent reaches it; one that does not has
 * changed what the room's buffer holds — `RoomMemory.revise`, done first, for every edit — and starts nothing.
 */

import { createLogger, type Gateway, type MessageEnvelope, type TakenSecret } from "@nouride/shared";
import { parseCommand } from "@/modules/hooks/registry.ts";
import type { ArrivalParts } from "./arrival.ts";
import { tellTaken } from "./chat-secrets.ts";
import { recentEdit, reviseWaiting, sameWords } from "./edit-rules.ts";
import { redrawSteer, steerOnArrival } from "./steer-accept.ts";

const log = createLogger("pipeline.edits");

/** Messages whose latest words this keeps. The oldest go first: an edit is about something said minutes ago. */
const LEDGER_CAP = 1_000;

/**
 * What each recently edited message says now — so an edit sent again with the same words, the preview loading after the
 * edit, is known as nothing new. In memory: a restart loses it, and the inbox still holds what each message first said.
 */
export class EditLedger {
  private readonly latest = new Map<string, string>();

  private static key(envelope: MessageEnvelope): string {
    return `${envelope.gatewayId} ${envelope.chatId} ${envelope.edit?.of ?? envelope.id}`;
  }

  /** What the message an edit changes said last, when an edit of it came through here. */
  said(edit: MessageEnvelope): string | undefined {
    return this.latest.get(EditLedger.key(edit));
  }

  remember(edit: MessageEnvelope): void {
    const key = EditLedger.key(edit);
    this.latest.delete(key);
    this.latest.set(key, edit.text);
    for (const oldest of this.latest.keys()) {
      if (this.latest.size <= LEDGER_CAP) break;
      this.latest.delete(oldest);
    }
  }
}

/** One edit from `gateway`, from arrival to where it goes — `arrive` hands every edit here. */
export function arriveEdit(parts: ArrivalParts, gateway: Gateway, envelope: MessageEnvelope, taken: readonly TakenSecret[] = []): void {
  const edit = envelope.edit!;
  const about = { gateway: envelope.gatewayId, chat_id: envelope.chatId, of: edit.of };
  // What the room heard is corrected whoever it was for, before anything decides who answers — where `observe` records.
  parts.rooms.revise(envelope);
  parts.chatTypes.remember(envelope);
  parts.admission.resetJobWakeChain(envelope.gatewayId, envelope.chatId);
  if (!parts.admission.admit(envelope)) return;
  // What `arrive` took out of the edit before any of that, said to the person now they are let in (`chat-secrets.ts`).
  tellTaken(parts.deps, gateway, envelope, taken);
  const isCommand = (text: string) => parts.hooks.has(parseCommand(text)?.command ?? "");
  // Words, never a command: `/approve` written into an old message must not answer what is waiting now.
  if (isCommand(envelope.text)) return void log.info("an edit that now reads as a command, not run", about);

  const edited = (message: MessageEnvelope) => message.gatewayId === envelope.gatewayId && message.chatId === envelope.chatId && message.id === edit.of;
  const waiting = parts.waiting(edited) ?? parts.turnContext.unread(edited);
  if (waiting) {
    if (sameWords(waiting.text, envelope.text)) return void log.debug("an edit that changes nothing visible: the message waits as it was", about);
    reviseWaiting(waiting, envelope);
    parts.inbox.revise(waiting);
    parts.edits.remember(envelope);
    redrawSteer(parts.turnContext, waiting);
    return void log.info("an edit of a message still waiting: it is answered as corrected", about);
  }

  const answering = parts.turnContext.answering(envelope.gatewayId, envelope.chatId, edit.of);
  const recorded = parts.inbox.recorded(envelope.gatewayId, envelope.chatId, edit.of);
  const was = parts.edits.said(envelope) ?? recorded?.text ?? answering?.text;
  if (was !== undefined && sameWords(was, envelope.text)) return void log.debug("an edit that changes nothing visible: nothing to answer", about);
  const sentAt = edit.sentAt ?? recorded?.sentAt;
  // Its turn has ended: answered again only while recent. A turn still at work on it reads it whenever it comes.
  if (!answering && !recentEdit(sentAt, envelope.timestamp || Date.now())) {
    return void log.info("an edit of a message sent too long ago, not answered again", { ...about, sent_at: sentAt });
  }
  envelope.edit = { ...edit, ...(sentAt === undefined ? {} : { sentAt }), ...(was === undefined ? {} : { was }) };
  parts.edits.remember(envelope);
  // Written down like any message: a redelivered edit is not answered twice, and a restart answers one still owed.
  if (!parts.inbox.intake(envelope)) return;
  log.info(answering ? "an edit of a message a turn is at work on" : "an edit of a message already answered", about);
  // A one-to-one chat's turn at work reads it at its next step, as it would a message sent now; anywhere else it is
  // routed as a message, and the agent it is for reads it in its turn or answers it in one of its own (`inbound.ts`).
  if (parts.deps.config.queue.steer && steerOnArrival(parts.turnContext, envelope, { isCommand, gateway })) return;
  parts.batcher.accept(envelope);
}
