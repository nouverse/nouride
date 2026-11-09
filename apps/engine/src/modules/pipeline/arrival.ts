/**
 * What happens when a message arrives, in the order it has to happen — before anything decides who answers.
 *
 * The room's record of it, its files in the conversation's list, what kind of chat it is, the unattended budget
 * starting over; then `admit` and the inbox; then the read receipt, a steer into the turn already running, or the
 * batcher. Each placement fixed a bug, and each says so where it is. `Pipeline.attach` runs it for every message, in
 * one transaction, so a message costs fewer commits. It was the body of `attach()`, which kept the composition root at
 * its budget.
 */

import { parseCommand, type HookRegistry } from "@/modules/hooks/registry.ts";
import type { Gateway, MessageEnvelope } from "@nouride/shared";
import { messageAttachmentRefs } from "@/modules/attachments/chat-attachments.store.ts";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import type { Admission } from "./admission.ts";
import type { Batcher } from "./batcher.ts";
import type { ChatTypes } from "./chat-types.ts";
import { tellTaken, type ChatSecrets } from "./chat-secrets.ts";
import { isEdit } from "./edit-rules.ts";
import { arriveEdit, type EditLedger } from "./edits.ts";
import type { InboxDesk } from "./inbox-desk.ts";
import type { RoomMemory } from "./room-memory.ts";
import { steerOnArrival } from "./steer-accept.ts";
import type { TurnContext } from "./turn-context.ts";

/** The collaborators an arrival reaches, handed over by the pipeline that built them. */
export interface ArrivalParts {
  deps: PipelineDeps;
  rooms: RoomMemory;
  chatTypes: ChatTypes;
  admission: Admission;
  inbox: InboxDesk;
  hooks: HookRegistry;
  turnContext: TurnContext;
  batcher: Batcher;
  /** A message not yet taken by a turn — held in the media batcher, or in the queue — that `match` picks. For its edit. */
  waiting: (match: (envelope: MessageEnvelope) => boolean) => MessageEnvelope | undefined;
  /** What recently edited messages say now (`edits.ts`). */
  edits: EditLedger;
  /** The credentials people send, taken out as their messages arrive (`chat-secrets.ts`). Absent, nothing is taken. */
  secrets?: ChatSecrets;
}

/** One message from `gateway`, from arrival to the queue — or to where it stops. */
export function arrive(parts: ArrivalParts, gateway: Gateway, envelope: MessageEnvelope): void {
  // Before anything keeps or reads it — the room's record, the inbox, a steer, a turn — and before the edit's own path,
  // which keeps one as well. The person is told once they are let in (`chat-secrets.ts`).
  const taken = parts.secrets?.take(envelope) ?? [];
  // A person's edit of a message they sent: where that message is decides what it does (`edits.ts`).
  if (isEdit(envelope)) return arriveEdit(parts, gateway, envelope, taken);
  // Before `admit`, and that placement is the feature rather than an oversight — see `observe`.
  parts.rooms.observe(envelope);
  // What the room is called, asked of its platform when not known or a day old — not awaited: no message waits on a name.
  if (envelope.chatType !== "dm" && !isSystemEvent(envelope)) void parts.deps.roomNames?.refresh(gateway, envelope.chatId);
  /**
   * The room's own record of what was said, written before anything decides who answers.
   *
   * That order is the whole point. A message that addresses nobody is still part of the
   * conversation — most messages in a busy room are — and recording it only when an agent runs
   * is what made an untagged message disappear: pending forever in the composer, a stop button
   * that never stopped, and "no turn started" thirty seconds later.
   *
   * Only what *people* say. An agent's reply is a turn, with its steps and its timings, and a
   * second copy here would be two records of one reply that can disagree. `senderIsBot` covers
   * both ways a reply comes back — a platform handing every bot its own copy, and the engine's
   * own echo on a shared connection.
   */
  if (envelope.chatType !== "dm" && !envelope.senderIsBot && !isSystemEvent(envelope)) {
    parts.deps.roomMessages?.record({
      id: envelope.id,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      senderId: envelope.senderId,
      ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
      text: envelope.text,
      ...(envelope.attachments?.length
        ? {
            attachments: envelope.attachments.map((attachment) => ({
              name: attachment.filename ?? "file",
              mimeType: attachment.mimeType,
              kind: attachment.type,
            })),
          }
        : {}),
      at: envelope.timestamp,
      ...(envelope.idsPerConnection ? { idsPerConnection: true } : {}),
    });
  }
  /**
   * The conversation's list of files, written on the same terms as its messages.
   *
   * Metadata only — nothing is fetched here. This is the row that makes a file reachable at
   * all: an untagged message's attachment has no reader, so nothing downstream would ever have
   * touched it, and the platform handle in this envelope is the only way back to the bytes.
   *
   * Every message, including a DM and including an agent's own, because "which files are in
   * this conversation" is not a question about who was addressed. The ref is derived from the
   * message and its conversation, so the copy each connection in a room receives collapses onto one row.
   */
  if (envelope.attachments?.length && !isSystemEvent(envelope)) {
    const refs = messageAttachmentRefs(envelope, envelope.id, envelope.attachments.length);
    envelope.attachments.forEach((attachment, index) => {
      parts.deps.attachmentIndex?.register({
        ref: refs[index]!,
        gateway: envelope.gateway,
        chatId: envelope.chatId,
        gatewayId: envelope.gatewayId,
        name: attachment.filename ?? attachment.type,
        mimeType: attachment.mimeType,
        kind: attachment.type,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        handle: attachment,
        ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
        ...(envelope.fromAgent ? { fromAgent: envelope.fromAgent } : {}),
        at: envelope.timestamp,
      });
    });
  }
  // Same placement, same reason: what kind of room this is does not depend on who said it, and a
  // stranger the daemon is about to ignore still told us truthfully. This is the only place the
  // platform's answer is available, and four other paths need it later — see `chat-types.ts`.
  parts.chatTypes.remember(envelope);
  /**
   * A person spoke, so the unattended budget starts over.
   *
   * Before `admit`, deliberately, and for the same reason the two calls above are: somebody is
   * demonstrably in the conversation. Whether the daemon will *answer* them is a separate
   * question — a rate-limited or unpaired sender is still a human being present, and the ceiling
   * exists to bound work nobody is watching.
   */
  if (!isSystemEvent(envelope)) {
    parts.admission.resetJobWakeChain(envelope.gatewayId, envelope.chatId);
  }
  if (!parts.admission.admit(envelope)) return;
  tellTaken(parts.deps, gateway, envelope, taken);
  if (!parts.inbox.intake(envelope)) return;
  /**
   * Blue ticks, here and not earlier.
   *
   * Only once the sender is admitted and the message is queued for real work. Marking it read
   * on arrival would put a read marker on messages the daemon then drops — telling a stranger
   * in `pair` mode that they were seen by something that is in fact ignoring them.
   *
   * Fire-and-forget: a platform that cannot show read state has no method here at all, and a
   * receipt that fails is not a reason to lose the message.
   */
  void gateway.markRead?.(envelope.chatId, envelope.id).catch(() => {});
  // Read by the turn already at work in this one-to-one chat, at its next step — `steering.ts` — or, past what one
  // turn reads, left to wait for it with its sender told so (`steer-accept.ts`).
  const isCommand = (text: string) => parts.hooks.has(parseCommand(text)?.command ?? "");
  if (parts.deps.config.queue.steer && steerOnArrival(parts.turnContext, envelope, { isCommand, gateway })) return;
  parts.batcher.accept(envelope);
}
