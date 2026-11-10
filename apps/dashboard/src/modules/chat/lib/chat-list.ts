/**
 * What the chat list shows, in what order — pure, so each rule is tested as the lists it gives.
 *
 * Chats: the orchestrator always first, pinned, whatever it last did; then agents, rooms and the groups pinned here,
 * mixed, newest first, because "what was I doing" does not care which kind of conversation the answer is; then the
 * agents nobody has talked to here yet, at the end and still reachable.
 *
 * Groups: the conversations agents are in on chat apps, one row per group, and the rooms made here, newest first,
 * narrowed by a chip that counts each — an app's, or the dashboard's for its rooms; one quiet for two weeks or more
 * folded into one row at the end.
 */

import type { AgentSummary, ChatListAgent, ChatListGroup, ChatListPayload, ChatListRoom } from "@nouride/wire";

/** A group this long without a word goes under "Quiet": two weeks. */
export const QUIET_AFTER_MS = 14 * 86_400_000;

export type ChatRow =
  | { kind: "agent"; key: string; at: number; agent: AgentSummary; entry: ChatListAgent | undefined }
  | { kind: "room"; key: string; at: number; room: ChatListRoom }
  | { kind: "group"; key: string; at: number; group: ChatListGroup };

export interface ChatsView {
  /** The orchestrator, first and kept there. Null without one, or when a search leaves it out. */
  pinned: Extract<ChatRow, { kind: "agent" }> | null;
  /** Agents with a conversation here, rooms and pinned groups, newest first. */
  recent: ChatRow[];
  /** Agents nobody has talked to here yet. */
  untouched: Extract<ChatRow, { kind: "agent" }>[];
}

/** A group's key, the same whichever of our bots it was heard through: its app and its chat. */
export const groupKey = (group: Pick<ChatListGroup, "platform" | "chatId">): string => `${group.platform}:${group.chatId}`;

/** Whether a search finds `words`: every word typed, anywhere in them, whatever the case. */
function finds(query: string, words: (string | undefined)[]): boolean {
  const asked = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (asked.length === 0) return true;
  const said = words.filter(Boolean).join(" ").toLowerCase();
  return asked.every((word) => said.includes(word));
}

const named = (agent: AgentSummary) => agent.displayName || agent.id;

export function chatsView(input: {
  agents: AgentSummary[];
  orchestrator: string | null;
  list: ChatListPayload | undefined;
  /** The groups pinned to Chats in this browser, by `groupKey`. */
  pinnedGroups: readonly string[];
  query: string;
  /** An agent's name by its id, for a room's members. */
  nameOf: (agentId: string) => string;
}): ChatsView {
  const { agents, orchestrator, list, pinnedGroups, query, nameOf } = input;
  const entries = new Map((list?.agents ?? []).map((entry) => [entry.agentId, entry]));

  const agentRows = agents
    .map((agent): Extract<ChatRow, { kind: "agent" }> => {
      const entry = entries.get(agent.id);
      return { kind: "agent", key: `agent:${agent.id}`, at: entry?.at ?? 0, agent, entry };
    })
    .filter((row) => finds(query, [named(row.agent), row.agent.id, row.entry?.last?.text]));
  const rooms = (list?.rooms ?? [])
    .map((room): ChatRow => ({ kind: "room", key: `room:${room.chatId}`, at: room.at, room }))
    .filter((row) => row.kind === "room" && finds(query, [row.room.title, ...row.room.members.map(nameOf), ...row.room.members, row.room.last?.text]));
  const groups = (list?.groups ?? [])
    .filter((group) => pinnedGroups.includes(groupKey(group)))
    .map((group): ChatRow => ({ kind: "group", key: `group:${groupKey(group)}`, at: group.at, group }))
    .filter((row) => row.kind === "group" && finds(query, [row.group.name, row.group.last?.text]));

  const pinned = agentRows.find((row) => row.agent.id === orchestrator) ?? null;
  const others = agentRows.filter((row) => row !== pinned);
  const recent = [...others.filter((row) => row.entry?.sessionId), ...rooms, ...groups].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  const untouched = others.filter((row) => !row.entry?.sessionId).sort((a, b) => named(a.agent).localeCompare(named(b.agent)));
  return { pinned, recent, untouched };
}

/** The Groups tab's chip for the rooms made in the dashboard, after the apps'. */
export const DASHBOARD = "dashboard";

/** A row of Groups: a group on a chat app, or a room made here — the same rows, and keys, as Chats draws them. */
export type GroupsRow = Extract<ChatRow, { kind: "room" | "group" }>;

export interface GroupsView {
  /** "All", each app there is a group on, and the dashboard where it has rooms, each with how many. */
  chips: { value: string; label: string; count: number }[];
  /** Groups heard from in the last two weeks, newest first. */
  active: GroupsRow[];
  /** The rest, newest first: folded into one row. */
  quiet: GroupsRow[];
}

export function groupsView(
  groups: readonly ChatListGroup[],
  rooms: readonly ChatListRoom[],
  input: { platform: string; query: string; now: number; nameOf: (agentId: string) => string; platformName: (platform: string) => string },
): GroupsView {
  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group.platform, (counts.get(group.platform) ?? 0) + 1);
  const chips = [
    { value: "all", label: "All", count: groups.length + rooms.length },
    ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([platform, count]) => ({ value: platform, label: input.platformName(platform), count })),
    ...(rooms.length > 0 ? [{ value: DASHBOARD, label: "Dashboard", count: rooms.length }] : []),
  ];
  const all = input.platform === "all";
  const groupRows = groups
    .filter((group) => all || group.platform === input.platform)
    .filter((group) => finds(input.query, [group.name, group.last?.text, group.last?.name, ...group.agents.map(input.nameOf)]))
    .map((group): GroupsRow => ({ kind: "group", key: `group:${groupKey(group)}`, at: group.at, group }));
  const roomRows = (all || input.platform === DASHBOARD ? rooms : [])
    .filter((room) => finds(input.query, [room.title, room.last?.text, room.last?.name, ...room.members.map(input.nameOf), ...room.members]))
    .map((room): GroupsRow => ({ kind: "room", key: `room:${room.chatId}`, at: room.at, room }));
  const shown = [...groupRows, ...roomRows].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  return {
    chips,
    active: shown.filter((row) => input.now - row.at < QUIET_AFTER_MS),
    quiet: shown.filter((row) => input.now - row.at >= QUIET_AFTER_MS),
  };
}

/** What a row's line says was said last: "Nouva: done", or the person's words alone in their own chat. */
export function lastLine(last: ChatListAgent["last"], who: (from: NonNullable<ChatListAgent["last"]>) => string | undefined): string | undefined {
  if (!last) return undefined;
  const by = who(last);
  return by ? `${by}: ${last.text}` : last.text;
}
