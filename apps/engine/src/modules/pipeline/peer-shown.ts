/**
 * An asked agent's answer, also said in the room it was asked in.
 *
 * `ask_agent` runs the agent asked behind the chat, and its answer goes to the agent that asked as a tool's result. In
 * a one-to-one chat that is the point. In a room the agent asked is often right there, one of its members, and the
 * people in it watched one agent speak for another: a status line with its name, then its words retold by somebody
 * else.
 *
 * So where the chat is a room and the agent asked is one of its members, its answer is also said there, as its own
 * message. One text, two readers, and no model asked again: the agent asked is told from the start that the room reads
 * its answer (`briefing`, `peer-turn.ts`), and the agent that asked is told the answer was shown (`renderHandoff`), to
 * add what is its own and not say it again.
 *
 * Said, and nothing more (`Voice.reply` `said`): in the asked agent's own voice or not at all, handing nothing on
 * whatever it tags, and kept as a turn of its own in that chat, so a room in the dashboard draws it and a reload still
 * has it. Said once however it ran, since it is said where its turn ends: waited for, behind the asking turn, or one of
 * several asked in one call.
 */

import { createLogger, newId, sessionId, SHOWN_ANSWER, type MessageEnvelope } from "@nouride/shared";
import type { PeerTurnRequest } from "@/modules/tools/builtins/ask-agent.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { TurnRecorder } from "@/modules/turns/recorder.ts";
import { SYSTEM_SENDER } from "./deps.ts";
import type { TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline.peer-turn");

/** The connection an asked agent's answer is said on. */
export interface ShownIn {
  gatewayId: string;
}

/**
 * Where an asked agent's answer is also said, or null where it only goes back to the agent that asked: a one-to-one
 * chat, and a room the agent asked is not in.
 *
 * A room made in the dashboard has a member list. A group on a chat app has none of ours, and nothing says which bots
 * were invited to it: there the agent asked needs a bot of its own, connected, that does not say it cannot read this
 * chat. One that speaks through another agent's bot would be saying its answer under that agent's name.
 */
export function shownIn(ctx: TurnContext, request: PeerTurnRequest, peerId: string): ShownIn | null {
  if (request.ctx.chatType === "dm") return null;
  const room = ctx.deps.rooms?.get(request.ctx.gatewayId, request.ctx.chatId);
  if (room) return room.members.some((member) => member.agentId === peerId) ? { gatewayId: request.ctx.gatewayId } : null;
  const own = ctx.voice.voiceGatewayId(peerId, request.ctx.gatewayId);
  if (ctx.deps.config.gateways.find((gateway) => gateway.id === own)?.agent !== peerId) return null;
  return ctx.deps.gateways.get(own)?.sees?.(request.ctx.chatId) === false ? null : { gatewayId: own };
}

/**
 * Whether what an asked agent handed back is an answer to put in front of people: its words, where it finished them.
 * Not one whose model call failed partway, which is half a sentence; not one a stop cut short; not one with no words.
 */
export function worthSaying(handoff: Pick<SubAgentHandoff, "status" | "summary">, stopped: boolean): boolean {
  return handoff.status !== "failed" && !stopped && handoff.summary.trim() !== "";
}

/**
 * What an asked agent handed back, with its answer said in the room where it is one to say there (`shown`). Asked
 * where its turn ends: an agent taken out of the room while it worked is not said into it.
 */
export async function shownReport(ctx: TurnContext, request: PeerTurnRequest, peerId: string, handoff: SubAgentHandoff, end: { stopped: boolean; model: string }): Promise<SubAgentHandoff> {
  const room = shownIn(ctx, request, peerId);
  return room && worthSaying(handoff, end.stopped) && (await sayInRoom(ctx, request, peerId, room, handoff.summary, end.model)) ? { ...handoff, shown: true } : handoff;
}

/** Say it there, and keep it as that agent's turn in the chat. True once it was said. */
async function sayInRoom(ctx: TurnContext, request: PeerTurnRequest, peerId: string, where: ShownIn, text: string, model: string): Promise<boolean> {
  const envelope: MessageEnvelope = {
    id: newId("msg"),
    timestamp: Date.now(),
    gateway: request.ctx.gateway,
    gatewayId: request.ctx.gatewayId,
    chatId: request.ctx.chatId,
    chatType: request.ctx.chatType,
    // The daemon's own: there is no message of a person's for this to quote.
    senderId: SYSTEM_SENDER,
    senderName: "",
    text: "",
    raw: { via: SHOWN_ANSWER },
  };
  if (!(await ctx.voice.reply(envelope, text, peerId, { said: true }))) return false;
  // Its own turn there: what it was asked is the brief, drawn nowhere in a room, and its answer is the reply.
  const record = TurnRecorder.begin(ctx.deps.turns, {
    sessionId: sessionId(peerId, where.gatewayId, request.ctx.chatId),
    agentId: peerId,
    gatewayId: where.gatewayId,
    chatId: request.ctx.chatId,
    senderId: SYSTEM_SENDER,
    prompt: request.task,
    cause: { via: SHOWN_ANSWER, asked: request.from, ...(request.ctx.turnId ? { parent: request.ctx.turnId } : {}) },
  });
  record?.finish({ status: "done", reply: text, model });
  log.info("an asked agent's answer was said in the room", { from: request.from, agent_id: peerId, chat_id: request.ctx.chatId, gateway: where.gatewayId });
  return true;
}
