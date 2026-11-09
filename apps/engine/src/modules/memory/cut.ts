/**
 * Cutting a chat into episodes — `docs/SPEC.md` §12.2.
 *
 * A chat is cut at two moments only: `/new` or `/reset` in it, and the nightly pass, which cuts every
 * chat active since its last cut. No idle timer: a quiet hour does not end a day's conversation, and
 * every episode is a model call.
 *
 * An episode is built from the turn log and, in a group, the room's message log — never from the
 * session's context, which compaction rewrites and `/new` clears. In a DM each turn is a question and
 * its answer. In a group the people's side comes from the room log, which holds every message
 * including the ones nobody answered, and only the agents' replies come from the turns, so a message
 * that triggered a turn is not written twice.
 *
 * One cut can yield several episodes: a stretch is split at each local day it crosses (a night the
 * pass did not run leaves one episode per day, not one for the week), and past the size cap — what
 * one nightly call reads without truncating — at an entry boundary. A piece with no agent in it joins
 * its neighbour, since an episode needs an agent taking part; a stretch with no person in it (a
 * reminder firing into an empty chat) is not an episode at all.
 */

import { keepEnds, type Person } from "@nouride/shared";
import { memoryChatKey } from "./access.ts";
import { localTime } from "@/commons/clock.ts";
import type { Episode } from "./episode.ts";
import { identityOf, nameOf } from "./people.ts";
import { slugOf } from "./vault.ts";

/** Characters of transcript one episode may hold — what a nightly call reads whole. */
const EPISODE_MAX_CHARS = 24_000;
/**
 * Characters one message keeps. Episodes are split between messages, so without this a single pasted
 * log or tool dump would be an episode of any size, read whole by one call. Its head and tail say
 * what it was; the middle of a 200 KB log is not what anyone remembers.
 */
const ENTRY_MAX_CHARS = 6_000;

export interface Entry {
  at: number;
  /** A person's identity, or an agent id when `agent` is set. */
  who: string;
  /** How the transcript names them. */
  name: string;
  agent: boolean;
  text: string;
}

/**
 * The two logs a chat is read from. Boot adapts the turn and room stores to this, and leaves out what
 * no person said — a scheduled job's prompt has no sender here, so it is never a participant.
 */
export interface ChatSource {
  exchangesBetween(gatewayId: string, chatId: string, after: number, until: number): { agentId: string; senderId?: string; prompt: string; reply: string; startedAt: number; endedAt: number }[];
  roomMessagesBetween(gatewayId: string, chatId: string, after: number, until: number): { senderId: string; senderName?: string; text: string; at: number }[];
  isRoom(gatewayId: string, chatId: string): boolean;
  /**
   * The knowledge documents opened in the chat in a window, `<collection>/<path>` (0.8.23): kept on the episodes they
   * fall in. Boot reads them from the audit log; a source without it files episodes that opened none.
   */
  documentsOpenedBetween?(gatewayId: string, chatId: string, after: number, until: number): { at: number; document: string }[];
}

/** The chat's entries in a window, oldest first. */
export function entriesOf(source: ChatSource, people: readonly Person[], chat: { gatewayId: string; chatId: string }, after: number, until: number): { kind: "dm" | "group"; entries: Entry[] } {
  const { gatewayId, chatId } = chat;
  const group = source.isRoom(gatewayId, chatId);
  const entries: Entry[] = [];
  const person = (senderId: string, fallback?: string): Pick<Entry, "who" | "name"> => {
    const who = identityOf(people, { gatewayId, senderId });
    return { who, name: nameOf(people, who, fallback) };
  };

  for (const exchange of source.exchangesBetween(gatewayId, chatId, after, until)) {
    if (!group && exchange.senderId && exchange.prompt.trim()) {
      entries.push({ at: exchange.startedAt, ...person(exchange.senderId), agent: false, text: exchange.prompt.trim() });
    }
    if (exchange.reply.trim()) {
      entries.push({ at: exchange.endedAt, who: exchange.agentId, name: exchange.agentId, agent: true, text: exchange.reply.trim() });
    }
  }
  if (group) {
    for (const message of source.roomMessagesBetween(gatewayId, chatId, after, until)) {
      if (!message.text.trim()) continue;
      entries.push({ at: message.at, ...person(message.senderId, message.senderName), agent: false, text: message.text.trim() });
    }
  }
  return { kind: group ? "group" : "dm", entries: entries.sort((a, b) => a.at - b.at) };
}

/** How long before an agent's first reply what people said still opens its conversation. */
const OPENING_MS = 86_400_000;

/**
 * The entries without what people said more than a day before the first agent reply — talk in a group no agent was
 * part of, not the question the reply answers. A cut starts where the chat's latest episode ended, so a family group
 * whose agent was asked something once a month opened each episode with the month's talk; a cursor in the database
 * used to move past it each night.
 */
export function withoutStaleOpening(entries: readonly Entry[]): Entry[] {
  const first = entries.find((entry) => entry.agent);
  return first ? entries.filter((entry) => entry.at >= first.at - OPENING_MS) : [...entries];
}

function render(entries: readonly Entry[], timeZone: string): string {
  return `${entries.map((entry) => `${localTime(entry.at, timeZone).time} · ${entry.name}\n${entry.text}`).join("\n\n")}\n`;
}

/** Split at each local day and wherever the cap would be passed, then fold pieces with no agent into their neighbour. */
function pieces(entries: readonly Entry[], timeZone: string, maxChars = EPISODE_MAX_CHARS): Entry[][] {
  const out: Entry[][] = [];
  let current: Entry[] = [];
  let size = 0;
  let day = "";
  for (const whole of entries) {
    const entry = { ...whole, text: keepEnds(whole.text, ENTRY_MAX_CHARS) };
    const length = entry.text.length + entry.name.length + 10;
    const entryDay = localTime(entry.at, timeZone).day;
    if (current.length && (size + length > maxChars || entryDay !== day)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
    day = entryDay;
  }
  if (current.length) out.push(current);
  // A piece with no agent is a question still waiting for its answer: it goes with the piece after
  // it, and only the last one, with nothing after, stays with the piece before.
  const merged: Entry[][] = [];
  let waiting: Entry[] = [];
  for (const piece of out) {
    if (!piece.some((entry) => entry.agent)) {
      waiting.push(...piece);
      continue;
    }
    merged.push([...waiting, ...piece]);
    waiting = [];
  }
  if (waiting.length) {
    const last = merged[merged.length - 1];
    if (last) last.push(...waiting);
    else merged.push(waiting);
  }
  return merged;
}

/** The episodes a cut writes: raw, one per piece, ids unique against `taken`. */
export function episodesOf(input: {
  chat: { gatewayId: string; chatId: string };
  kind: "dm" | "group";
  entries: readonly Entry[];
  timeZone: string;
  group?: string;
  taken: (id: string) => boolean;
  maxChars?: number;
}): Episode[] {
  const episodes: Episode[] = [];
  for (const piece of pieces(input.entries, input.timeZone, input.maxChars)) {
    const agents = [...new Set(piece.filter((entry) => entry.agent).map((entry) => entry.who))];
    const people = [...new Set(piece.filter((entry) => !entry.agent).map((entry) => entry.who))];
    if (agents.length === 0 || people.length === 0) continue;
    const start = localTime(piece[0]!.at, input.timeZone);
    const end = localTime(piece[piece.length - 1]!.at, input.timeZone);
    const base = `${start.day}-${start.slug}-${slugOf(agents[0]!) ?? "agent"}`;
    let id = base;
    for (let n = 2; input.taken(id) || episodes.some((episode) => episode.id === id); n += 1) id = `${base}-${n}`;
    episodes.push({
      id,
      status: "raw",
      kind: input.kind,
      chat: memoryChatKey(input.chat.gatewayId, input.chat.chatId),
      started: start.iso,
      ended: end.iso,
      day: start.day,
      agents,
      people,
      mentions: [],
      ...(input.kind === "group" && input.group ? { group: input.group } : {}),
      tags: [],
      related: [],
      transcript: render(piece, input.timeZone),
    });
  }
  // Consecutive pieces of one cut are one conversation, split for the model: say so.
  for (const [index, episode] of episodes.entries()) {
    episode.related = [episodes[index - 1]?.id, episodes[index + 1]?.id].filter((id): id is string => Boolean(id));
  }
  return episodes;
}

/** A readable group slug for a chat no stub names yet: `telegram-1001234567`. */
export function groupSlugFor(gatewayId: string, chatId: string): string {
  const platform = gatewayId.split(":")[0] ?? "chat";
  return slugOf(`${platform}-${chatId}`)?.slice(0, 48) ?? platform;
}
