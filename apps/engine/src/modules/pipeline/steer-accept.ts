/**
 * A message taken into the turn already at work — the half of steering (`steering.ts`) that acts, shared by both
 * of its doors: a one-to-one chat on arrival (`index.ts`), a room once routing has said whose it is (`inbound.ts`).
 *
 * Said back at once — "↪ Got it", which becomes a line in the agent's own words once one is written (`steer-reply.ts`) —
 * and drawn on the turn's record, which is where the dashboard reads a conversation from. Before, it had nothing to read: the local
 * connection hands a reply only to a request waiting for one, and the dashboard's never waits, so both lines went
 * nowhere; and a one-to-one chat is drawn from its turns, so the message itself appeared only once the turn read it,
 * as a step quoting its first 120 characters. Sent from the dashboard, a message seemed to vanish.
 *
 * Drawn while the turn is at work, as it was said. One the turn never reads becomes the next turn's question
 * (`TurnContext.releaseTurn`), which takes what was drawn for it back off this one.
 */

import { createLogger, type Gateway, type MessageEnvelope, type TurnStepKind } from "@nouride/shared";
import { editLine, isEdit } from "./edit-rules.ts";
import { replyToSteer } from "./steer-reply.ts";
import { busyNotice, cappedTarget, STEER_ACK_EDIT, STEER_ACK_PARKED, steerAck, steerTarget, unaddressed } from "./steering.ts";
import type { ActiveTurn, TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline.steering");

/**
 * A one-to-one chat's door (`steering.ts`): a message for the turn at work there is taken into it — true, the message
 * is handled. Past what one turn reads it is left to wait for the turn to end, as before — false — and its sender is
 * told so once a turn, where the message used to wait in silence for up to `queue_timeout_ms`.
 */
export function steerOnArrival(
  ctx: TurnContext,
  envelope: MessageEnvelope,
  o: { isCommand: (text: string) => boolean; gateway: Gateway },
): boolean {
  const send: Say = async (text) =>
    rewriter(o.gateway, envelope.chatId, await o.gateway.send({ gatewayId: envelope.gatewayId, chatId: envelope.chatId, text }).catch(() => []));
  const parked = () => ctx.deps.approvals.pending().some((request) => request.gateway === envelope.gatewayId && request.chatId === envelope.chatId);
  const steered = steerTarget(ctx.activeTurns.values(), envelope, o.isCommand);
  if (steered) {
    const held = parked();
    void acceptSteer(ctx, steered, envelope, { ack: held ? STEER_ACK_PARKED : isEdit(envelope) ? STEER_ACK_EDIT : steerAck(ctx.deps, steered.agentId), parked: held, send });
    return true;
  }
  const capped = cappedTarget(ctx.activeTurns.values(), envelope, o.isCommand);
  // Not a turn already past its last step: it is ending, and the message starts the next one in a moment.
  if (capped && !capped.answered) {
    // Drawn on the turn while it waits, as a steer is, and the notice with it: the dashboard's connection keeps nothing
    // it is sent, so it showed neither. Taken back when the turn ends (`releaseTurn`) — the next turn's question then.
    const agent = ctx.deps.registry.get(capped.agentId);
    const draw = drawer(ctx, capped, envelope);
    drawSaid(ctx, capped, envelope, draw);
    (capped.waiting ??= []).push(envelope);
    if (!capped.told?.has(envelope.senderId)) {
      (capped.told ??= new Set()).add(envelope.senderId);
      const notice = busyNotice({ id: capped.agentId, displayName: agent?.config.displayName ?? "" }, capped, { parked: parked(), queued: true });
      draw("steer_reply", notice);
      void send(notice);
    }
  }
  return false;
}

/** Rewrites a message already sent, where its connection can (`Gateway.editMessage`) — false where it could not. */
export type Rewrite = (text: string) => Promise<boolean>;

/** Sends a line into the chat, and answers how to rewrite it — nothing where it cannot be. */
export type Say = (text: string) => Promise<Rewrite | undefined>;

/** How to rewrite what one send put on `gateway`: one message, on a connection that edits — nothing otherwise. */
function rewriter(gateway: Gateway | undefined, chatId: string, ids: readonly string[]): Rewrite | undefined {
  const edit = gateway?.editMessage?.bind(gateway);
  const [id, ...more] = ids;
  return edit && id !== undefined && more.length === 0 ? (text) => edit(chatId, id, text).catch(() => false) : undefined;
}

/** A room's door: said as the agent, through its own bot where it has one (`Voice.reply`), and rewritable as above. */
export function sayAs(ctx: TurnContext, envelope: MessageEnvelope, agentId: string): Say {
  return async (text) => {
    let sent: Rewrite | undefined;
    await ctx.voice.reply(envelope, text, agentId, { onSent: (gatewayId, ids) => (sent = rewriter(ctx.deps.gateways.get(gatewayId), envelope.chatId, ids)) });
    return sent;
  };
}

/**
 * Take the message into the turn, say so, and draw both on its record. Resolves once "Got it" has gone, or at once
 * for a turn past its last step — which reads nothing more, so the message starts the next one unannounced
 * (`ActiveTurn.answered`).
 */
export function acceptSteer(
  ctx: TurnContext,
  turn: ActiveTurn,
  envelope: MessageEnvelope,
  o: {
    /** `STEER_ACK`, or the form for a turn parked on an approval. */
    ack: string;
    /** Waiting on an approval in this chat: no line in the agent's words while that decides what comes next. */
    parked: boolean;
    /** Through the platform, as the agent where it speaks with its own connection. */
    send: Say;
  },
): Promise<unknown> {
  // As it arrived: the inbox knows it by this object (`TurnContext.holds`), and one no turn reads is this agent's
  // next turn, which takes the address off itself. The model is shown it without (`takeSteers`).
  turn.steers!.push(envelope);
  if (turn.answered) return Promise.resolve();
  const draw = drawer(ctx, turn, envelope);
  drawSaid(ctx, turn, envelope, draw);
  draw("steer_reply", o.ack);
  const acked = o.send(o.ack);
  // One bubble a steered message, not two: "Got it" becomes the agent's line where the connection can rewrite it, and
  // the line follows it where it cannot. Live (0.8.7), every message sent while Nix worked left two bubbles under it.
  if (!o.parked) {
    replyToSteer(ctx, turn, envelope, async (line) => {
      const rewrite = await acked;
      draw("steer_reply", line);
      if (!(rewrite && (await rewrite(`↪ ${line}`)))) await o.send(line);
    });
  }
  // A coding CLI's turn hands it over mid-prompt where its CLI can take it (0.8.10, `external-agents/steering.ts`) —
  // told after the line above is asked for, which it waits on: told first, a CLI with no tool call open took the words
  // at once, and the line, ready seconds later, was dropped as late every time (live, 2026-10-31).
  turn.onSteer?.();
  return acked;
}

/**
 * What the person said, as the turn's record draws it: without the address the dashboard's connection and a room put in
 * front — unless that was all there was — and an edit marked as one, with the message it changes (stream 1.3).
 */
function drawSaid(ctx: TurnContext, turn: ActiveTurn, envelope: MessageEnvelope, draw: Draw): void {
  const agent = ctx.deps.registry.get(turn.agentId);
  const said = unaddressed(envelope.text, turn.agentId, agent?.config.displayName ?? "").trim() || envelope.text.trim();
  if (envelope.edit) draw("steer", editLine(said), { editOf: envelope.edit.of });
  else draw("steer", said);
}

/**
 * A message drawn on a turn it waits on — to be read at its next step, or past what one turn reads — edited before it
 * was read: its line is taken back and drawn again as it now reads. What was said back to it stays.
 */
export function redrawSteer(ctx: TurnContext, envelope: MessageEnvelope): void {
  for (const turn of ctx.activeTurns.values()) {
    const [line, ...rest] = turn.drawn?.get(envelope) ?? [];
    if (line === undefined || !turn.recordId) continue;
    try {
      ctx.deps.turns?.unstep(turn.recordId, [line]);
    } catch (err) {
      log.debug("an edited message's line not taken back", { chat_id: turn.chatId, error: String(err) });
    }
    turn.drawn!.set(envelope, rest);
    drawSaid(ctx, turn, envelope, drawer(ctx, turn, envelope));
  }
}

type Draw = (kind: TurnStepKind, text: string, detail?: Record<string, unknown>) => void;

/**
 * Writes onto the turn's record what is said while the turn is at work — never once it has ended: its record is
 * closed then, and what was drawn for a message it never read has been taken back off it. The record is looked up
 * once (the turn opens it a moment after it registers, and a message in between is not drawn), and every failure
 * is swallowed: a transcript that cannot be written is never a reason to lose the message.
 */
function drawer(ctx: TurnContext, turn: ActiveTurn, envelope: MessageEnvelope): Draw {
  return (kind, text, detail) => {
    const turns = ctx.deps.turns;
    if (!turns || ctx.turnIn(turn.agentId, turn.chatId, turn.gatewayId) !== turn) return;
    try {
      const recordId = turn.recordId ?? turns.runningFor(turn.agentId, turn.gatewayId, turn.chatId);
      if (!recordId) return;
      turn.recordId = recordId;
      const seq = turns.step(recordId, kind, text, detail);
      if (seq > 0) (turn.drawn ??= new Map()).set(envelope, [...(turn.drawn.get(envelope) ?? []), seq]);
    } catch (err) {
      log.debug("steering not drawn on the turn", { chat_id: turn.chatId, error: String(err) });
    }
  };
}
