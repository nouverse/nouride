/**
 * The chat page's list in one read (`GET /chat-list`): each agent's newest conversation in the dashboard, each dashboard
 * room and each group on a chat app, with the last line said there and whether anyone works there now.
 *
 * Read-only, and read as `/sessions` is: anyone signed in, a mission's own conversation left out. Built from what the
 * stores already answer one query at a time — the session rows, each one's newest turn, the room log — so a list of
 * twenty rows costs twenty small indexed reads, not a transcript each.
 */

import { oneLine, type GatewayName, type Session } from "@nouride/shared";
import type { ChatListAgent, ChatListGroup, ChatListLine, ChatListPayload, ChatListRoom } from "@nouride/wire";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { personFor, SESSIONS_READ, speakersOf, SPOKEN } from "@/modules/pipeline/known-rooms.ts";
import { personWhoOpened } from "@/modules/sessions/sessions.store.ts";
import type { TurnRecord } from "@/modules/turns/turns.store.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { isMine, readerAs, readerOf, Spoke, whoseAsked, type Reader } from "../whose.ts";

/** A preview is one line of a list: longer than any row is wide, and nothing past it is ever drawn. */
const LINE = 160;
/** An agent's own conversations in the dashboard looked through for the newest that is not a room's or a job's. */
const OWN_READ = 30;

/**
 * A message as a list's preview: one line of plain words, its thinking, code blocks and markdown marks gone. Only the
 * marks around words: an identifier keeps its underscores.
 */
function preview(text: string): string {
  const plain = oneLine(
    text
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, " ")
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>)\s?/gm, "")
      .replace(/\*\*|__|~~|`/g, ""),
  );
  return plain.length > LINE ? `${plain.slice(0, LINE - 1).trimEnd()}…` : plain;
}

/** What a turn left as the last word: its answer, else the question it is still on. A wake-up's text is nobody's words. */
function turnLine(turn: TurnRecord | null): (ChatListLine & { at: number }) | undefined {
  if (!turn) return undefined;
  const at = turn.endedAt ?? turn.startedAt;
  const reply = preview(turn.reply);
  if (reply) return { from: "agent", name: turn.agentId, text: reply, at };
  if (turn.cause) return undefined;
  const asked = preview(turn.prompt);
  return asked ? { from: "person", text: asked, at: turn.startedAt } : undefined;
}

/** The newer of two lines, either missing. */
function newer<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

const bare = (line: (ChatListLine & { at: number }) | undefined): { last?: ChatListLine } =>
  line ? { last: { from: line.from, ...(line.name ? { name: line.name } : {}), text: line.text } } : {};

/**
 * The person's latest words in a chat, from its room log as any of `connections` heard it, under the name the
 * conversation shows them by (`senders.ts`).
 */
function saidLast(deps: ControlDeps, connections: readonly string[], chatId: string): (ChatListLine & { at: number }) | undefined {
  const message = deps.roomMessages?.inRoom(connections, chatId, 1).at(-1);
  const text = message ? preview(message.text) : "";
  const name = message ? (personFor(deps.ctx.config.people, message.gatewayId, message.senderId)?.name ?? message.senderName) : undefined;
  return message && text ? { from: "person", ...(name ? { name } : {}), text, at: message.at } : undefined;
}

/**
 * How many people spoke in a group lately: the ones the Groups page names, and whoever its log holds as any of our bots
 * there heard it. Each bot keeps what it was handed, and one can be handed less than another (added later, or a Telegram
 * bot handed only what tags it), so the log is read across them all, a line two of them heard once.
 */
function peopleCount(deps: ControlDeps, connections: readonly string[], chatId: string, known: readonly { key?: string; name: string }[]): number {
  const who = new Set(known.map((one) => (one.key ? `person:${one.key}` : one.name)));
  const lines = deps.roomMessages?.inRoom(connections, chatId, SPOKEN) ?? [];
  for (const one of speakersOf(deps.ctx.config.people, lines)) who.add(one.key ? `person:${one.key}` : one.name);
  return who.size;
}

/**
 * Each agent's newest conversation in the dashboard that the reader opened: not a room's (a room is its own row), not a
 * scheduled job's. Each account has its own with each agent; the control token, with no account, reads the newest of
 * anyone's. One whose first turn is still running has no row yet, so it is read from that turn, as `/sessions` reads it.
 */
function agentsOf(deps: ControlDeps, local: string, rooms: Set<string>, running: Set<string>, reader: Reader): ChatListAgent[] {
  const own = (chatId: string) => !rooms.has(chatId) && cronJobOfChat(chatId) === null;
  const anyone = reader.ids.length === 0 && reader.everyone;
  const opened = (by: string | undefined) => anyone || (by !== undefined && reader.ids.includes(by));
  const opening = new Map<string, TurnRecord>();
  for (const id of running) {
    if (deps.sessions?.find(id)) continue;
    const turn = deps.turns?.latestForSession(id);
    if (turn?.status === "running" && turn.gatewayId === local && own(turn.chatId) && opened(personWhoOpened(turn))) opening.set(turn.agentId, turn);
  }
  return deps.registry.all().map((agent) => {
    const agentId = agent.config.id;
    const row = deps.sessions
      ?.list({ agentId, gateway: local, limit: OWN_READ, ...(anyone ? {} : { openedBy: reader.ids }) })
      .find((session) => own(session.chatId));
    const first = opening.get(agentId);
    const sessionId = first && (!row || first.startedAt > row.updatedAt) ? first.sessionId : row?.id;
    if (!sessionId) return { agentId, working: false, helpers: 0 };
    const turn = first?.sessionId === sessionId ? first : (deps.turns?.latestForSession(sessionId) ?? null);
    const line = turnLine(turn);
    const chatId = turn?.chatId ?? row?.chatId ?? "";
    const helpers = (deps.jobs?.running(agentId) ?? []).filter((job) => job.kind === "helper" && job.gatewayId === local && job.chatId === chatId).length;
    return {
      agentId,
      sessionId,
      at: Math.max(row?.id === sessionId ? row.updatedAt : 0, turn?.startedAt ?? 0, line?.at ?? 0),
      ...bare(line),
      working: running.has(sessionId),
      helpers,
    };
  });
}

/** The dashboard's rooms, with who answers a message there that tags nobody. */
function roomsOf(deps: ControlDeps, local: string, platform: GatewayName): ChatListRoom[] {
  return (deps.rooms?.list(local) ?? []).map((room) => {
    const turn = deps.turns?.forChat(local, room.chatId, 1).at(-1) ?? null;
    const line = newer(turnLine(turn), saidLast(deps, [local], room.chatId));
    const untagged = deps.pipeline.untaggedAnswerer({ gateway: platform, gatewayId: local, chatId: room.chatId });
    return {
      chatId: room.chatId,
      ...(room.title ? { title: room.title } : {}),
      members: room.members.map((member) => member.agentId),
      at: Math.max(room.createdAt, line?.at ?? 0, turn?.startedAt ?? 0),
      ...bare(line),
      working: (deps.turns?.runningForChat(local, room.chatId) ?? []).length > 0,
      ...(untagged ? { untagged } : {}),
    };
  });
}

/** Each agent's tag on a platform, the tag to the agent, where any has one: `<@1001…>` read as the agent it tags. */
function tagsOn(deps: ControlDeps, platform: string): { tags?: Record<string, string> } {
  const tags = Object.fromEntries(Object.entries(deps.pipeline.agentTags(platform as GatewayName)).map(([agentId, tag]) => [tag, agentId]));
  return Object.keys(tags).length > 0 ? { tags } : {};
}

/** The groups on chat apps: the Groups page's rooms (one per chat on its platform), with each agent's conversation there. */
function groupsOf(deps: ControlDeps, running: Set<string>): ChatListGroup[] {
  const platformOf = (gatewayId: string) => deps.ctx.gateways.get(gatewayId)?.platform ?? gatewayId.split(":")[0] ?? gatewayId;
  const recent: Session[] = deps.sessions?.list({ limit: SESSIONS_READ, notGateway: MISSION_GATEWAY_ID }) ?? [];
  return deps.pipeline
    .knownRooms()
    .filter((group) => !group.dashboard)
    .map((group) => {
      const sessions = recent.filter((session) => session.chatId === group.chatId && session.sessionType === "main" && platformOf(session.gatewayId) === group.platform);
      // Every connection of ours there, all on the group's platform: what `inRoom` reads the group across.
      const connections = [...new Set([group.gatewayId, ...sessions.map((session) => session.gatewayId)])];
      let line = saidLast(deps, connections, group.chatId);
      for (const session of sessions) line = newer(line, turnLine(deps.turns?.latestForSession(session.id) ?? null));
      return {
        platform: group.platform,
        chatId: group.chatId,
        ...(group.name ? { name: group.name } : {}),
        agents: group.agents,
        sessions: sessions.map((session) => ({ agentId: session.agentId, sessionId: session.id, gatewayId: session.gatewayId })),
        at: Math.max(group.lastActive, line?.at ?? 0),
        ...bare(line),
        working: sessions.some((session) => running.has(session.id)),
        people: peopleCount(deps, connections, group.chatId, group.people),
        ...tagsOn(deps, group.platform),
      };
    })
    .sort((a, b) => b.at - a.at);
}

export function registerChatListRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The reader's own (`whose.ts`): their conversation with each agent, the rooms they made or spoke in, the groups they
   * spoke in. `?whose=everyone`, an admin's alone, lists every room and group; the agents' rows stay their own.
   */
  control.get("/chat-list", (c) => {
    const local = deps.local?.id;
    const running = deps.turns?.runningSessions() ?? new Set<string>();
    const reader = readerOf(c.get("principal"), deps.ctx.config.people);
    const whose = whoseAsked(reader, c.req.query("whose"), deps.ctx.config.people);
    // Everyone's rooms and groups for everyone's, and for the chats nobody is known for: a group is nobody's private
    // chat. One person's are where that person spoke, as the reader's own are where the reader did.
    const all = whose.kind === "everyone" || whose.kind === "unknown";
    const asReader = readerAs(whose, reader);
    const spoke = new Spoke(deps, asReader);
    const mine = (gatewayId: string, chatId: string) => all || isMine(deps, asReader, { gatewayId, chatId }, spoke);
    // Every room keeps its conversations off the agents' rows, the reader's or not.
    const rooms = local ? roomsOf(deps, local, deps.local?.platform ?? "web") : [];
    const payload: ChatListPayload = {
      agents: local ? agentsOf(deps, local, new Set(rooms.map((room) => room.chatId)), running, reader) : [],
      rooms: rooms.filter((room) => mine(local!, room.chatId)),
      // A group is the reader's where their person spoke, on whichever of our bots heard it.
      groups: groupsOf(deps, running).filter((group) => all || spoke.in(group.platform, group.chatId)),
    };
    return c.json(payload satisfies ChatListPayload);
  });
}
