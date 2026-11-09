/**
 * The rooms the daemon knows (0.7.24): group chats where an agent has a conversation, and the dashboard's rooms — what
 * the Groups page lists and renames, and what `send_message` reads a chat's kind, name and people from.
 *
 * Flat: a WhatsApp group, a Telegram group, a Discord channel, a Discord thread, a dashboard room — each one chat id on
 * one platform, each its own conversation. No server or workspace is modelled above them. A room several of our bots
 * sit in is one room here, keyed as the platform sees it (platform + chat id), with every agent that talks there.
 */

import type { RoomMessage } from "@/modules/chat-events/room-messages.store.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { idsOf, personIdMatches } from "@/modules/people/match.ts";
import { roomName } from "@/modules/rooms/room-names.store.ts";
import type { Person } from "@nouride/shared";
import { SYSTEM_SENDER, type PipelineDeps } from "./deps.ts";
import type { ChatTypes } from "./chat-types.ts";

/** Conversations looked at, most recent first — a household's chats, not a public bot's every visitor. */
export const SESSIONS_READ = 200;
/** People named for a group: who spoke there last. */
const PRESENT = 6;
/** A group's lines read for who spoke there lately. */
export const SPOKEN = 50;
/** Longer than any group name anyone gives; past it is a paste, not a name. */
const MAX_TITLE = 100;

type Who = { key?: string; name: string };

export interface KnownRoom {
  /** The connection to address it through — the most recently active one, when several of our bots are in it. */
  gatewayId: string;
  platform: string;
  chatId: string;
  /** Its name (`roomName`): a dashboard room's title, else the operator's rename, else the platform's. */
  name?: string;
  /** What the platform calls it, where it said — what a cleared rename falls back to. */
  platformTitle?: string;
  /** A dashboard room: named by its own title, which a rename changes. */
  dashboard: boolean;
  /** The agents with a conversation there. */
  agents: string[];
  /** Who spoke there lately, by `[[people]]` name where they are in it. */
  people: Who[];
  /** When a conversation there last moved. */
  lastActive: number;
}

/** Who an account is in `[[people]]`, by key and name. */
export function personFor(people: readonly Person[], gatewayId: string, senderId: string): { key: string; name: string } | undefined {
  const found = people.find((person) => idsOf(person).some((id) => personIdMatches(id, { gatewayId, senderId })));
  return found ? { key: found.key, name: found.name } : undefined;
}

/** A room or a one-to-one: a dashboard room, a chat with a room log, or what a platform said of it this process. */
export function chatKind(deps: Pick<PipelineDeps, "rooms" | "roomMessages">, gatewayId: string, chatId: string, chatTypes?: Pick<ChatTypes, "of">): "dm" | "group" {
  if (deps.rooms?.get(gatewayId, chatId) || deps.roomMessages?.isRoom(gatewayId, chatId)) return "group";
  const said = chatTypes?.of(gatewayId, chatId);
  return said !== undefined && said !== "dm" ? "group" : "dm";
}

/** Who said these lines of a group, the latest speaker first, by `[[people]]` name where they are in it. */
export function speakersOf(people: readonly Person[], lines: readonly RoomMessage[]): Who[] {
  const seen = new Map<string, Who>();
  for (const message of [...lines].reverse()) {
    if (message.senderId === SYSTEM_SENDER) continue;
    const person = personFor(people, message.gatewayId, message.senderId);
    // One person on two accounts is one name: keyed by who they are, not which account wrote.
    const who = person?.key ? `person:${person.key}` : `account:${message.senderId}`;
    if (seen.has(who)) continue;
    seen.set(who, person ?? { name: message.senderName ?? message.senderId });
    if (seen.size >= PRESENT) break;
  }
  return [...seen.values()];
}

/** Who is in a chat, as far as the daemon knows: the person on the other end of a one-to-one, or who spoke in a group lately. */
export function peopleIn(deps: Pick<PipelineDeps, "config" | "roomMessages" | "turns">, gatewayId: string, chatId: string, kind: "dm" | "group"): Who[] {
  const people = deps.config.people;
  if (kind === "group") return speakersOf(people, deps.roomMessages?.forChat(gatewayId, chatId, SPOKEN) ?? []);
  // The address of a one-to-one is the person's account on most platforms; where it is not, the turns there say who spoke.
  const senders = [chatId, ...(deps.turns?.forChat(gatewayId, chatId, 3) ?? []).map((turn) => turn.senderId ?? "")].filter((id) => id && id !== SYSTEM_SENDER);
  for (const id of senders) {
    const person = personFor(people, gatewayId, id);
    if (person) return [person];
  }
  const sender = senders.at(-1) ?? chatId;
  return [{ name: deps.roomMessages?.lastNameOf(gatewayId, sender) ?? sender }];
}

/** What the rooms are read from: the stores that know a room, and the people and turns that say who is in one. */
export type RoomSources = Pick<PipelineDeps, "config" | "gateways" | "sessions" | "turns" | "rooms" | "roomMessages" | "roomNames">;

/** Every room the daemon knows, most recently active first. */
export function knownRooms(deps: RoomSources, chatTypes?: Pick<ChatTypes, "of">): KnownRoom[] {
  const found = new Map<string, KnownRoom>();
  const add = (gatewayId: string, chatId: string, agentId: string | undefined, at: number) => {
    const gateway = deps.gateways.get(gatewayId);
    if (!gateway) return;
    const key = `${gateway.platform}\u0000${chatId}`;
    const known = found.get(key);
    if (known) {
      if (agentId && !known.agents.includes(agentId)) known.agents.push(agentId);
      if (at > known.lastActive) Object.assign(known, { gatewayId, lastActive: at });
      return;
    }
    const dashboard = Boolean(deps.rooms?.get(gatewayId, chatId));
    const platformTitle = dashboard ? undefined : deps.roomNames?.get(gateway.platform, chatId)?.platformTitle;
    found.set(key, {
      gatewayId,
      platform: gateway.platform,
      chatId,
      dashboard,
      ...(platformTitle ? { platformTitle } : {}),
      agents: agentId ? [agentId] : [],
      people: [],
      lastActive: at,
    });
  };

  for (const session of deps.sessions.list({ limit: SESSIONS_READ })) {
    if (session.sessionType !== "main" || cronJobOfChat(session.chatId) !== null) continue;
    if (chatKind(deps, session.gatewayId, session.chatId, chatTypes) !== "group") continue;
    add(session.gatewayId, session.chatId, session.agentId, session.updatedAt);
  }
  // A dashboard room nobody has spoken in yet is still a room somebody made.
  for (const gatewayId of deps.gateways.keys()) {
    for (const room of deps.rooms?.list(gatewayId) ?? []) {
      add(gatewayId, room.chatId, undefined, room.createdAt);
      const known = found.get(`${deps.gateways.get(gatewayId)!.platform}\u0000${room.chatId}`)!;
      for (const member of room.members) if (!known.agents.includes(member.agentId)) known.agents.push(member.agentId);
    }
  }

  return [...found.values()]
    .map((room) => {
      const name = roomName(deps, room);
      return { ...room, ...(name ? { name } : {}), people: peopleIn(deps, room.gatewayId, room.chatId, "group") };
    })
    .sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Rename a room: a dashboard room's own title, or the operator's name for a platform room. Empty clears it — a
 * platform room is then called what its platform calls it again.
 */
export function renameRoom(
  deps: Pick<PipelineDeps, "gateways" | "rooms" | "roomNames">,
  gatewayId: string,
  chatId: string,
  title: string,
): { ok: true; name?: string } | { ok: false; reason: string; why: "connection" | "long" | "unkept" } {
  const gateway = deps.gateways.get(gatewayId);
  if (!gateway) return { ok: false, reason: `no connection ${gatewayId}`, why: "connection" };
  const chosen = title.trim();
  if (chosen.length > MAX_TITLE) return { ok: false, reason: `a name is at most ${MAX_TITLE} characters`, why: "long" };
  if (deps.rooms?.get(gatewayId, chatId)) deps.rooms.rename(gatewayId, chatId, chosen || null);
  else if (deps.roomNames) deps.roomNames.choose(gateway.platform, chatId, chosen || null);
  else return { ok: false, reason: "room names are not kept by this daemon", why: "unkept" };
  const name = roomName(deps, { gatewayId, platform: gateway.platform, chatId });
  return { ok: true, ...(name ? { name } : {}) };
}
