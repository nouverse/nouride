/**
 * The pipeline's half of `send_message`: which chats an agent can reach, putting a message into one, and recording
 * what the daemon said in a chat without a turn there — a sent message, or a scheduled job's delivered output.
 *
 * ## Reachable
 *
 * Through a connection that is the agent's: one it owns (`[gateways.*] agent`), or one without an owner where it already
 * has a conversation. The chats are its conversations on those (never a cron run's), and on a connection it owns, the
 * one-to-one chat with each person in `[[people]]` who has an account on that platform — the account is the chat's
 * address there. A connection another agent owns is out, whatever conversations this agent has through it.
 *
 * ## Recorded
 *
 * Into this agent's conversation in that chat, after it landed: a `[system]` line saying where it came from, then the
 * message as the agent's own. A pair rather than the reply alone, so the history still alternates and starts with a
 * user message — a provider refuses one that opens with the assistant — and so the next turn there knows why it said
 * something nobody in that chat asked for. The line carries no timestamp: the overheard block counts from when the
 * agent was last spoken to (`lastAddressedAt`), and a note is not someone speaking.
 *
 * A turn of this agent running in that chat would save its own copy of the history over the append, so the append
 * waits for it to end (`waitUntilFree`), and is written in the same step as the read, with nothing awaited between.
 */

import { estimateMessagesTokens } from "@nouride/llm";
import { contained, createLogger, type ChatMessage, type ChatType, type GatewayName, type ToolContext } from "@nouride/shared";
import { capStoredTurns } from "@/modules/llm/context.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { idsOf } from "@/modules/people/match.ts";
import { roomName } from "@/modules/rooms/room-names.store.ts";
import type { ReachableChat, SendTargets } from "@/modules/tools/builtins/send-message.ts";
import { SYSTEM_SENDER, type PipelineDeps } from "./deps.ts";
import type { TurnContext } from "./turn-context.ts";
import type { ChatTypes } from "./chat-types.ts";
import { chatKind, peopleIn, personFor, SESSIONS_READ, type RoomSources } from "./known-rooms.ts";

const log = createLogger("pipeline.send-message");

/** The chats `agentId` may send into, and the connections it may not use — `send_message`'s `targets`. */
export function sendTargets(deps: RoomSources, agentId: string, chatTypes?: Pick<ChatTypes, "of">): SendTargets {
  const othersGateways = deps.config.gateways.filter((gateway) => gateway.agent && gateway.agent !== agentId).map((gateway) => gateway.id);
  const usable = (gatewayId: string) => deps.gateways.has(gatewayId) && !othersGateways.includes(gatewayId);

  const chats = new Map<string, ReachableChat>();
  const add = (gatewayId: string, chatId: string, lastActive: number) => {
    const address = `${gatewayId}:${chatId}`;
    if (chats.has(address)) return;
    const platform = deps.gateways.get(gatewayId)!.platform;
    // A room's log is written only in a group; what a platform said of the chat this process, where the log is empty.
    const kind = chatKind(deps, gatewayId, chatId, chatTypes);
    // Its one name (`roomName`): a dashboard room's title, the operator's rename, the platform's — never a memory file's.
    const title = kind === "group" ? roomName(deps, { gatewayId, platform, chatId }) : undefined;
    chats.set(address, { gatewayId, chatId, platform, kind, ...(title ? { title } : {}), people: peopleIn(deps, gatewayId, chatId, kind), lastActive });
  };

  for (const session of deps.sessions.list({ agentId, limit: SESSIONS_READ })) {
    if (session.sessionType !== "main" || cronJobOfChat(session.chatId) !== null || !usable(session.gatewayId)) continue;
    add(session.gatewayId, session.chatId, session.updatedAt);
  }
  // A person's one-to-one on a connection this agent owns — reachable before it ever talked there.
  for (const gateway of deps.config.gateways) {
    if (gateway.agent !== agentId || !usable(gateway.id)) continue;
    for (const person of deps.config.people) {
      for (const id of idsOf(person)) {
        if (id.startsWith(`${gateway.platform}:`)) add(gateway.id, id.slice(gateway.platform.length + 1), 0);
      }
    }
  }
  return { chats: [...chats.values()].sort((a, b) => b.lastActive - a.lastActive), othersGateways };
}

/**
 * Every chat some agent can send into, most recently active first — what the Schedule and Webhooks forms offer as where
 * a job's results go (0.8.0). Those offered bare chat ids, and nobody could tell `5550001111` from `-1005550002`; this
 * says which is a one-to-one and with whom, and which a group and its name, as `send_message` already knew.
 */
export function reachableChats(deps: RoomSources & Pick<PipelineDeps, "registry">, chatTypes?: Pick<ChatTypes, "of">): ReachableChat[] {
  const chats = new Map<string, ReachableChat>();
  for (const agent of deps.registry.all()) {
    for (const chat of sendTargets(deps, agent.config.id, chatTypes).chats) {
      const address = `${chat.gatewayId}:${chat.chatId}`;
      const known = chats.get(address);
      if (!known || chat.lastActive > known.lastActive) chats.set(address, chat);
    }
  }
  return [...chats.values()].sort((a, b) => b.lastActive - a.lastActive);
}

/** Where a message was sent from, for the line in front of it: "your telegram one-to-one with Sam". */
function origin(deps: PipelineDeps, ctx: ToolContext): string {
  const platform = ctx.gateway;
  const who = personFor(deps.config.people, ctx.gatewayId, ctx.senderId)?.name;
  return ctx.chatType === "dm"
    ? `your ${platform} one-to-one${who ? ` with ${who}` : ""}`
    : `a ${platform} group${who ? `, asked there by ${who}` : ""}`;
}

/**
 * Append what was said in a chat without a turn there to `agentId`'s conversation in it — now, or once its turn there
 * ends. Never throws: the message is out already, and a record that failed is a log line, not a failed send.
 */
export function recordSaid(turns: TurnContext, input: { agentId: string; gatewayId: string; chatId: string; text: string; note: string }): void {
  const key = { agentId: input.agentId, gatewayId: input.gatewayId, chatId: input.chatId };
  const write = contained(log, "could not record a message sent into a chat", () =>
    turns.atomically(() => {
      const note: ChatMessage = { role: "user", content: `[system] ${input.note}` };
      const said: ChatMessage = { role: "assistant", content: input.text, timestamp: Date.now() };
      const messages = capStoredTurns([...turns.deps.sessions.load(key).messages, note, said], turns.deps.config.security.maxConversationTurns);
      turns.deps.sessions.save(key, messages, estimateMessagesTokens(messages));
    }),
  );
  if (!turns.isBusy(input.agentId, input.chatId, input.gatewayId)) write();
  else void turns.waitUntilFree(input.agentId, input.chatId, input.gatewayId).then(write);
}

/**
 * A line from the daemon into the chat a tool call came from (0.8.8): what the person there is told of a change the agent
 * made to itself — `agent_configure` moving its coding CLI to another model, whose account's limits other agents share.
 * Not put into the conversation: the call's result, which is, says the same to the agent.
 */
export async function tellChat(turns: TurnContext, ctx: ToolContext, text: string): Promise<boolean> {
  const gateway = turns.deps.gateways.get(ctx.gatewayId);
  if (!gateway) return false;
  const envelope = { id: `told:${ctx.callId ?? Date.now()}`, timestamp: Date.now(), gateway: gateway.platform as GatewayName, gatewayId: ctx.gatewayId, chatId: ctx.chatId, chatType: ctx.chatType, senderId: SYSTEM_SENDER, senderName: "", text: "", raw: {} };
  return Boolean(await turns.voice.reply(envelope, text, ctx.agentId));
}

/**
 * A line the daemon says in a chat for an agent, outside any turn, and keeps in the agent's conversation there (0.8.23):
 * an admin's answer about a document the agent kept waiting for one. Without it the document was found once approved,
 * and the agent still said in that chat that it waited (0.8.20's full check).
 */
export async function sayInChat(turns: TurnContext, chat: { agentId: string; gatewayId: string; chatId: string; chatType: ChatType }, text: string, note: string): Promise<boolean> {
  const gateway = turns.deps.gateways.get(chat.gatewayId);
  if (!gateway) return false;
  const envelope = { id: `said:${Date.now()}`, timestamp: Date.now(), gateway: gateway.platform as GatewayName, gatewayId: chat.gatewayId, chatId: chat.chatId, chatType: chat.chatType, senderId: SYSTEM_SENDER, senderName: "", text: "", raw: {} };
  if (!(await turns.voice.reply(envelope, text, chat.agentId))) return false;
  recordSaid(turns, { agentId: chat.agentId, gatewayId: chat.gatewayId, chatId: chat.chatId, text, note });
  return true;
}

/** `send_message`'s `post`: out through the agent's voice in that chat, then into its conversation there. */
export async function postMessage(turns: TurnContext, ctx: ToolContext, chat: ReachableChat, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gateway = turns.deps.gateways.get(chat.gatewayId);
  if (!gateway) return { ok: false, reason: `${chat.gatewayId} is not connected` };
  // Again here, where the send is: whatever chose the chat, another agent's bot never speaks for this one.
  const owner = turns.deps.config.gateways.find((configured) => configured.id === chat.gatewayId)?.agent;
  if (owner && owner !== ctx.agentId) return { ok: false, reason: `${chat.gatewayId} is another agent's connection` };
  const delivered = await turns.voice.reply(
    {
      id: `sent:${ctx.callId ?? Date.now()}`,
      timestamp: Date.now(),
      gateway: gateway.platform as GatewayName,
      gatewayId: chat.gatewayId,
      chatId: chat.chatId,
      chatType: chat.kind,
      // The daemon's, so nothing is quoted: the message it would quote was never in that chat.
      senderId: SYSTEM_SENDER,
      senderName: "",
      text: "",
      raw: {},
    },
    text,
    ctx.agentId,
  );
  if (!delivered) return { ok: false, reason: `${chat.platform} did not take it: the connection is down, or it cannot reach that chat` };
  recordSaid(turns, {
    agentId: ctx.agentId,
    gatewayId: chat.gatewayId,
    chatId: chat.chatId,
    text,
    note: `You sent the message below into this chat with send_message, from ${origin(turns.deps, ctx)}. It is part of this conversation now: anyone here may answer it.`,
  });
  log.info("sent a message into another chat", { agent_id: ctx.agentId, from: `${ctx.gatewayId}:${ctx.chatId}`, to: `${chat.gatewayId}:${chat.chatId}`, chars: text.length });
  return { ok: true };
}
