/**
 * A message for an agent already at work in its chat: what is done with it, once `whileBusy` (`steering.ts`) has said
 * what becomes of it. Read by the turn, kept for when it ends, or refused, each said in the chat as the agent; and a
 * hand-over that waited too long for its agent, left with a word to the room.
 *
 * Apart from `inbound.ts`, which decides whether a message gets a turn at all: this is the one case where it does
 * not, yet, and what the room hears of that.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import type { ActiveTurn, HandedOver } from "./active-turns.ts";
import { isEdit } from "./edit-rules.ts";
import { acceptSteer, sayAs } from "./steer-accept.ts";
import { busyNotice, lapsedHandoverNotice, STEER_ACK_EDIT, STEER_ACK_PARKED, STEER_ACK_PARKED_ROOM, steerAck, whileBusy } from "./steering.ts";
import type { TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline");

/**
 * A hand-over that waited longer than a message may wait in the queue is left: it asked for work in a room that
 * has moved on since. Said in the room by the agent it was for, so nobody takes it for done.
 */
export async function lapsedHandover(ctx: TurnContext, agent: LoadedAgent, envelope: MessageEnvelope, handed: HandedOver): Promise<boolean> {
  const limit = ctx.deps.config.queue.queueTimeoutMs;
  const waited = Date.now() - handed.since;
  if (limit <= 0 || waited <= limit) return false;
  const id = agent.config.id;
  log.info("a hand-over waited too long for its agent", { agent_id: id, from: handed.from, chat_id: envelope.chatId, waited_ms: waited });
  const notice = lapsedHandoverNotice(handed.from, waited);
  await ctx.voice.reply(envelope, notice, id);
  ctx.deps.chatEvents?.record({
    gatewayId: envelope.gatewayId,
    chatId: envelope.chatId,
    audience: "ui",
    kind: "dropped",
    text: notice,
    agentId: id,
    details: { reason: "handover_lapsed", from: handed.from, messageId: envelope.id },
  });
  return true;
}

/**
 * A message for an agent already at work in this chat: read by its turn, said to be waiting, or refused.
 * `whileBusy` decides; this does it.
 *
 * Spoken as the agent, through its own bot where it has one: a reply quoting the message is what keeps
 * a busy room readable, and answering it reaches the agent. Recorded for the dashboard too, where a reply
 * through the local connection is handed to nobody: a steer on the turn's record (`steer-accept.ts`), a
 * refusal as an event of the room.
 */
export async function atWork(
  ctx: TurnContext,
  agent: LoadedAgent,
  envelope: MessageEnvelope,
  turn: ActiveTurn,
  o: { addressed: boolean; fromPerson: boolean; handed?: { from: string; hops: number } },
): Promise<void> {
  const id = agent.config.id;
  const outcome = whileBusy(turn, envelope, { addressed: o.addressed, fromPerson: o.fromPerson, steer: ctx.deps.config.queue.steer, handedOver: o.handed !== undefined });
  const parked = ctx.deps.approvals
    .pending()
    .some((request) => request.agentId === id && request.gateway === envelope.gatewayId && request.chatId === envelope.chatId);
  log.info("that agent is already working in this chat", { agent_id: id, chat_id: envelope.chatId, outcome });
  if (outcome === "steer") {
    const ack = !parked ? (isEdit(envelope) ? STEER_ACK_EDIT : steerAck(ctx.deps, id)) : envelope.chatType === "dm" ? STEER_ACK_PARKED : STEER_ACK_PARKED_ROOM;
    await acceptSteer(ctx, turn, envelope, { ack, parked, send: sayAs(ctx, envelope, id) });
    return;
  }
  if (outcome === "wait" && o.handed) {
    // Said when it first waits: one put back behind a turn that started first, or one that joins another, was said.
    const waitedBefore = ctx.handed.has(envelope);
    const joined = ctx.holdHandover(turn, envelope, o.handed);
    log.info("a hand-over waits for its agent", { agent_id: id, from: o.handed.from, chat_id: envelope.chatId, joined, again: waitedBefore });
    if (waitedBefore || joined) return;
    const waits = busyNotice({ id, displayName: agent.config.displayName }, turn, { parked, queued: true });
    await ctx.voice.reply(envelope, waits, id);
    ctx.deps.chatEvents?.record({
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      audience: "ui",
      kind: "note",
      text: waits,
      agentId: id,
      details: { reason: "handover_waits", from: o.handed.from, messageId: envelope.id },
    });
    return;
  }
  const notice = busyNotice({ id, displayName: agent.config.displayName }, turn, { parked });
  if (outcome === "tell") {
    // Before the send, so a second message from them racing this one is not told twice.
    (turn.told ??= new Set()).add(envelope.senderId);
    await ctx.voice.reply(envelope, notice, id);
  }
  ctx.deps.chatEvents?.record({
    gatewayId: envelope.gatewayId,
    chatId: envelope.chatId,
    audience: "ui",
    kind: "dropped",
    text: notice,
    agentId: id,
    ...(envelope.senderId ? { actor: envelope.senderId } : {}),
    details: { reason: "agent_busy", messageId: envelope.id },
  });
}
