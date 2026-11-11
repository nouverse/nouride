/**
 * Whose a conversation is, and who may open it.
 *
 * Every account that signed in read every chat. A second account on a Nouride is a second person, and what they said
 * to an agent in private is theirs. So a conversation is read by what it is:
 *
 * - a private chat, in the dashboard or on a chat app: by whoever opened it (`sessions.opened_by`) — the account that
 *   began it, the person on the other end — read through People, so one person's accounts on every platform are one;
 * - a group on a chat app, or a room in the dashboard: by whoever spoke there, and a room by who made it;
 * - a scheduled job's own conversation and a mission's: by everyone, as before. Their pages are not held by person yet.
 *
 * An admin and the control token open every one. Everyone else is answered, for a chat that is not theirs, as for a
 * chat that is not there: a refusal would say it exists. One question, asked by every route that names a
 * conversation (`conversation.ts`), and a contract holds each route to asking it (`whose-doors.test.ts`).
 */

import type { Person } from "@nouride/shared";
import { chatPlace } from "@/modules/chat-events/room-messages.store.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { idsOf } from "@/modules/people/match.ts";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import type { ControlDeps } from "./types.ts";

/** Who is asking, as far as reading conversations goes. */
export interface Reader {
  /** Every conversation is theirs to open: the control token, or an admin. */
  everyone: boolean;
  /** Who they are: their person's ids in People, or their account's alone when no person holds it. */
  ids: readonly string[];
  /** Their account's name, as a dashboard room records who made it. */
  username?: string;
  /** Their person's key in People, where one holds their account. */
  person?: string;
}

export function readerOf(principal: Pick<Principal, "kind" | "role" | "user">, people: readonly Person[]): Reader {
  const everyone = principal.kind === "token" || atLeast(principal as Principal, "admin");
  const account = principal.user;
  if (!account) return { everyone, ids: [] };
  const self = `web:${account.id}`;
  const person = people.find((one) => idsOf(one).includes(self));
  return { everyone, ids: person ? idsOf(person) : [self], username: account.username, ...(person ? { person: person.key } : {}) };
}

/** What a conversation is, which decides who reads it. */
export type ConversationKind = "private" | "group" | "room" | "job" | "mission";

/** What a conversation's kind is read from: the rooms made here, the room log, and what a chat's messages said it is. */
export type KindSources = Pick<ControlDeps, "rooms" | "roomMessages"> & { pipeline?: Partial<Pick<ControlDeps["pipeline"], "chatTypeOf">> };

export function kindOf(deps: KindSources, gatewayId: string, chatId: string): ConversationKind {
  if (gatewayId === MISSION_GATEWAY_ID) return "mission";
  if (cronJobOfChat(chatId) !== null) return "job";
  if (deps.rooms?.get(gatewayId, chatId)) return "room";
  // A group's lines are kept from its first message; a private chat's never are (`room-messages.store.ts`).
  if (deps.roomMessages?.isRoom(gatewayId, chatId)) return "group";
  const said = deps.pipeline?.chatTypeOf?.(gatewayId, chatId);
  return said !== undefined && said !== "dm" ? "group" : "private";
}

/** A conversation, as far as who opens it goes. */
export interface Where {
  gatewayId: string;
  chatId: string;
  /** Who opened it (`Session.openedBy`): absent before anybody spoke, or once its turns are gone. */
  openedBy?: string | undefined;
}

/**
 * The chats and rooms a reader spoke in, asked once per request: a list asks it for every row. `chatPlace` keys, so a
 * group several of our bots sit in is one place.
 */
export class Spoke {
  private found: Set<string> | null = null;

  constructor(
    private readonly deps: Pick<ControlDeps, "roomMessages">,
    private readonly reader: Reader,
  ) {}

  in(gatewayId: string, chatId: string): boolean {
    this.found ??= this.deps.roomMessages?.spokeIn(this.reader.ids) ?? new Set();
    return this.found.has(chatPlace(gatewayId, chatId));
  }
}

/**
 * Whether this conversation is the reader's own: what Mine lists, for an admin as for anyone. A scheduled job's and a
 * mission's are nobody's.
 */
export function isMine(deps: KindSources, reader: Reader, where: Where, spoke: Spoke): boolean {
  const kind = kindOf(deps, where.gatewayId, where.chatId);
  if (kind === "private") return where.openedBy !== undefined && reader.ids.includes(where.openedBy);
  if (kind === "group") return spoke.in(where.gatewayId, where.chatId);
  if (kind === "room") {
    const made = deps.rooms?.get(where.gatewayId, where.chatId)?.createdBy;
    return (reader.username !== undefined && made === reader.username) || spoke.in(where.gatewayId, where.chatId);
  }
  return false;
}

/** Whether the reader may open this conversation: everything for an admin, their own and what nobody owns for anyone. */
export function mayOpen(deps: KindSources, reader: Reader, where: Where, spoke: Spoke = new Spoke(deps, reader)): boolean {
  if (reader.everyone) return true;
  const kind = kindOf(deps, where.gatewayId, where.chatId);
  if (kind === "job" || kind === "mission") return true;
  return isMine(deps, reader, where, spoke);
}

/**
 * Whose conversations a list is asked for (`?whose=`): the reader's own; everyone's; one person's, `person:<key>`, by
 * every account of theirs; or the private chats nobody in People is known for, `unknown`. Every one but the first is an
 * admin's to ask: anyone else is answered with their own, whatever they ask. The control token, which is nobody,
 * reads everyone's when it asks for its own.
 */
export type Whose = { kind: "mine" | "everyone" } | { kind: "person"; ids: readonly string[] } | { kind: "unknown"; known: readonly string[] };

export function whoseAsked(reader: Reader, asked: string | undefined, people: readonly Person[]): Whose {
  if (!reader.everyone) return { kind: "mine" };
  if (asked === "everyone" || (reader.ids.length === 0 && (asked === undefined || asked === "mine"))) return { kind: "everyone" };
  if (asked?.startsWith("person:")) {
    const person = people.find((one) => one.key === asked.slice("person:".length));
    return { kind: "person", ids: person ? idsOf(person) : [] };
  }
  if (asked === "unknown") return { kind: "unknown", known: people.flatMap((one) => idsOf(one)) };
  return { kind: "mine" };
}

/** The reader a list of one person's is read as: that person, by every account of theirs. */
export function readerAs(whose: Whose, reader: Reader): Reader {
  return whose.kind === "person" ? { everyone: false, ids: whose.ids } : reader;
}

/**
 * Whether a row of the event stream is the reader's to see: one of a chat they may open, or of none. Asked for every
 * row a stream carries, so each chat is decided once and again a little later — a group they speak in from now on is
 * theirs from then.
 */
export function eventsFor(deps: KindSources & Pick<ControlDeps, "sessions">, reader: Reader, now: () => number = Date.now): (row: { gatewayId?: string | null; chatId?: string | null }) => boolean {
  if (reader.everyone) return () => true;
  const decided = new Map<string, { open: boolean; at: number }>();
  let spoke = new Spoke(deps, reader);
  let spokeAt = now();
  return (row) => {
    if (!row.chatId) return true;
    if (!row.gatewayId) return false;
    const key = `${row.gatewayId}\u0000${row.chatId}`;
    const known = decided.get(key);
    if (known && now() - known.at < DECIDED_MS) return known.open;
    if (now() - spokeAt >= DECIDED_MS) {
      spoke = new Spoke(deps, reader);
      spokeAt = now();
    }
    const open = mayOpen(deps, reader, { gatewayId: row.gatewayId, chatId: row.chatId, openedBy: deps.sessions?.openerOfChat(row.gatewayId, row.chatId) }, spoke);
    decided.set(key, { open, at: now() });
    return open;
  };
}

/** How long a stream keeps what it decided of one chat. */
const DECIDED_MS = 10_000;

/** Whether two readings of one reader still read the same chats: a stream opened as one ends when it changes. */
export function sameReader(a: Reader, b: Reader): boolean {
  return a.everyone === b.everyone && a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id)) && a.username === b.username;
}

/**
 * The reader as they are now: an account's role and person read again, so a stream opened before a change does not go
 * on carrying what the account may no longer read. Null for an account that is gone.
 */
export function readerNow(deps: Pick<ControlDeps, "users" | "ctx">, principal: Pick<Principal, "kind" | "role" | "user">): Reader | null {
  if (principal.kind !== "user" || !principal.user) return readerOf(principal, deps.ctx.config.people);
  const account = deps.users?.byId(principal.user.id);
  return account ? readerOf({ kind: "user", role: account.role, user: account }, deps.ctx.config.people) : null;
}
