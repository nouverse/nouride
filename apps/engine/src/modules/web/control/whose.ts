/**
 * Whose a conversation is, and who may open it.
 *
 * Every account that signed in read every chat. A second account on a Nouride is a second person, and what they said
 * to an agent in private is theirs. So a conversation is read by what it is:
 *
 * - a private chat, in the dashboard or on a chat app: by whoever opened it (`sessions.opened_by`) — the account that
 *   began it, the person on the other end — read through People, so one person's accounts on every platform are one;
 * - a group on a chat app, or a room in the dashboard: by whoever spoke there, and a room by who made it;
 * - an automation's own conversation and a mission's: by whoever sees the automation or the mission (below).
 *
 * An automation and a mission are a person's too (`Job.owner`, `Mission.owner`): every account read and changed every
 * one. Each is **seen** by its owner's person and by whoever may open the chat it reports to, since it writes there,
 * and **changed** by its owner's person alone. One nobody owns (made from the command line, a proposal nobody turned
 * on, one from before whose maker cannot be read) is seen by whoever its chat is, and changed by an admin.
 *
 * An admin and the control token open every one. Everyone else is answered, for a chat that is not theirs, as for a
 * chat that is not there: a refusal would say it exists. One question, asked by every route that names a
 * conversation (`conversation.ts`), and a contract holds each route to asking it (`whose-doors.test.ts`).
 */

import type { Job, Person } from "@nouride/shared";
import { chatPlace } from "@/modules/chat-events/room-messages.store.ts";
import { deliveryTarget } from "@/modules/cron/addressing.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { isDraft } from "@/modules/missions/drafts.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { Mission } from "@/modules/missions/types.ts";
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

/**
 * What a conversation's kind is read from: the rooms made here, the room log, and what a chat's messages said it is.
 * And, for an automation's own conversation and a mission's, the automation and the mission: who sees those reads it.
 */
export type KindSources = Pick<ControlDeps, "rooms" | "roomMessages"> &
  Partial<Pick<ControlDeps, "cron" | "missions" | "sessions">> & { pipeline?: Partial<Pick<ControlDeps["pipeline"], "chatTypeOf">> };

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

/**
 * Whether the reader may open this conversation: everything for an admin, their own for anyone, and an automation's
 * own or a mission's for whoever sees that automation or mission. One whose automation or mission is gone is an
 * admin's: nothing is left to say whose it was.
 */
export function mayOpen(deps: KindSources, reader: Reader, where: Where, spoke: Spoke = new Spoke(deps, reader)): boolean {
  if (reader.everyone) return true;
  const kind = kindOf(deps, where.gatewayId, where.chatId);
  if (kind === "job" || kind === "mission") {
    const thing = thingBehind(deps, kind, where.chatId);
    return thing !== null && isMineThing(deps, reader, thing, spoke);
  }
  return isMine(deps, reader, where, spoke);
}

/** An automation or a mission, as far as who sees it and who changes it goes. */
export interface Thing {
  /** Whose it is, as People writes an id. None is nobody's. */
  owner?: string | null | undefined;
  /** The chat it reports to; for a proposal, the chat it was proposed in. */
  reportsTo?: { gatewayId: string; chatId: string } | undefined;
  /**
   * Proposed by an agent and waiting for a person's yes: an automation not turned on, a mission nobody owns that has
   * not started. Whoever may open its chat answers it, and it becomes theirs.
   */
  proposed?: boolean;
}

export function thingOfJob(job: Pick<Job, "owner" | "proposal" | "target" | "delivery">): Thing {
  const reportsTo = job.proposal ? { gatewayId: job.proposal.gatewayId, chatId: job.proposal.chatId } : deliveryTarget(job as Job);
  return { owner: job.owner, reportsTo, ...(job.proposal ? { proposed: true } : {}) };
}

export function thingOfMission(mission: Pick<Mission, "owner" | "gatewayId" | "chatId" | "status" | "waitKind" | "startedAt">): Thing {
  const proposed = mission.owner === null && isDraft(mission);
  return { owner: mission.owner, reportsTo: { gatewayId: mission.gatewayId, chatId: mission.chatId }, ...(proposed ? { proposed } : {}) };
}

/** The automation or the mission a conversation of its own belongs to, or null once it is gone. */
function thingBehind(deps: KindSources, kind: "job" | "mission", chatId: string): Thing | null {
  if (kind === "mission") {
    const mission = deps.missions?.get(chatId);
    return mission ? thingOfMission(mission) : null;
  }
  const job = deps.cron?.store.get(cronJobOfChat(chatId) ?? "");
  return job ? thingOfJob(job) : null;
}

/**
 * Whether an automation or a mission is the reader's: they own it, or it reports to a chat that is theirs (`isMine`),
 * since what writes to a person's chat is theirs to read. What Mine lists, for an admin as for anyone. Another
 * automation's or mission's own conversation is no person's chat.
 */
function isMineThing(deps: KindSources, reader: Reader, thing: Thing, spoke: Spoke): boolean {
  if (thing.owner && reader.ids.includes(thing.owner)) return true;
  const to = thing.reportsTo;
  if (!to) return false;
  const kind = kindOf(deps, to.gatewayId, to.chatId);
  if (kind === "job" || kind === "mission") return false;
  return isMine(deps, reader, { ...to, openedBy: deps.sessions?.openerOfChat(to.gatewayId, to.chatId) }, spoke);
}

/** Whether the reader may change it: its owner's person, an admin, the control token. Seeing one is not that. */
function mayChangeThing(reader: Reader, thing: Thing): boolean {
  return reader.everyone || (thing.owner != null && reader.ids.includes(thing.owner));
}

/** The person a thing is for, by People: what an admin's Everyone sets it apart under. None for nobody's. */
function personOfOwner(people: readonly Person[], owner: string | null | undefined): { key: string; name: string } | undefined {
  if (!owner) return undefined;
  const person = people.find((one) => idsOf(one).includes(owner));
  return person ? { key: person.key, name: person.name ?? person.key } : undefined;
}

/**
 * One request's reading of automations and missions: who asks, whose they asked for (`?whose=`), and where each of
 * them spoke, asked once however long the list.
 */
export class Things {
  private readonly spoke: Spoke;
  private readonly asked: Reader;
  private readonly askedSpoke: Spoke;

  constructor(
    private readonly deps: KindSources,
    readonly reader: Reader,
    private readonly people: readonly Person[],
    private readonly whose: Whose = { kind: "mine" },
  ) {
    this.spoke = new Spoke(deps, reader);
    this.asked = readerAs(whose, reader);
    this.askedSpoke = this.asked === reader ? this.spoke : new Spoke(deps, this.asked);
  }

  /** Whether the reader may see it at all: what a route that names one by its id asks. */
  sees(thing: Thing): boolean {
    return this.reader.everyone || isMineThing(this.deps, this.reader, thing, this.spoke);
  }

  /** Whether the reader may act on it: its owner or an admin; and a proposal, whoever sees it, since a yes makes it theirs. */
  changes(thing: Thing): boolean {
    return mayChangeThing(this.reader, thing) || (thing.proposed === true && this.sees(thing));
  }

  /** Whether a list shows it: the reader's own, everyone's, one person's, or nobody's, as they asked. */
  listed(thing: Thing): boolean {
    if (!this.sees(thing)) return false;
    switch (this.whose.kind) {
      case "everyone":
        return true;
      case "unknown":
        return !thing.owner || !this.whose.known.includes(thing.owner);
      default:
        return isMineThing(this.deps, this.asked, thing, this.askedSpoke);
    }
  }

  /** What a page is told of whose it is and whether the reader may change it. */
  said(thing: Thing): { person?: { key: string; name: string }; changeable: boolean } {
    const person = personOfOwner(this.people, thing.owner);
    return { ...(person ? { person } : {}), changeable: this.changes(thing) };
  }
}

/** One request's `Things`: who asks, and whose they asked for (`?whose=`, an admin's to pick). */
export function thingsFor(deps: KindSources & Pick<ControlDeps, "ctx">, principal: Pick<Principal, "kind" | "role" | "user">, asked?: string): Things {
  const people = deps.ctx.config.people;
  const reader = readerOf(principal, people);
  return new Things(deps, reader, people, whoseAsked(reader, asked, people));
}

/**
 * The job of that id, for a reader who may see it; null where it is not theirs to know of. `changeable`: to run,
 * pause, turn on or delete it. `owned`: to rewrite it, which a proposal's answerer does not.
 */
export function jobFor(deps: KindSources & Pick<ControlDeps, "ctx">, principal: Pick<Principal, "kind" | "role" | "user">, id: string): { job: Job; things: Things; changeable: boolean; owned: boolean } | null {
  const job = deps.cron?.store.get(id);
  if (!job) return null;
  const things = thingsFor(deps, principal);
  const thing = thingOfJob(job);
  return things.sees(thing) ? { job, things, changeable: things.changes(thing), owned: mayChangeThing(things.reader, thing) } : null;
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
