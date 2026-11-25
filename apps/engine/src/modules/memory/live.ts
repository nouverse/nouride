/**
 * The conversations of other chats not cut into memory yet, read where they are: the turn log.
 *
 * A chat's talk becomes an episode when it is cut, by `/new` or the nightly pass, and memory knew nothing of it before.
 * Asked in a direct chat what was decided in a group an hour earlier, an agent said it could not see that group and
 * had to be asked there. The group's talk was in the turn log all along. Read here as the cut would read it, the same
 * pieces and ids (`episodesOf`), and kept to the same rule an episode is (`canSeeEpisode`): in a person's direct chat,
 * the chats they took part in, and nothing in a group but that group's own, which its conversation already holds. Never
 * written: the cut still files it, under the id given here where nothing else took it.
 *
 * Only the last day's activity, and the newest few: a turn's prompt names them, and a look at every chat ever is not
 * a turn's to pay for. Each is named by its first line, under an id that holds while it grows, so the prompt's cached
 * memory block changes when a conversation begins or is cut, not with each message in it.
 */

import { fileExistsSync } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { localTime, startOfLocalDay } from "@/commons/clock.ts";
import type { Person } from "@nouride/shared";
import { isMissionChat } from "@/modules/missions/gateway.ts";
import { canSeeEpisode, memoryChatKey, type Audience } from "./access.ts";
import { entriesOf, episodesOf, groupSlugFor, withoutStaleOpening } from "./cut.ts";
import { deletedUpToNow } from "./deleted.ts";
import { WITHIN_THE_SECOND_MS, type Episode } from "./episode.ts";
import { indexedEpisode } from "./index-sync.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import type { Recall } from "./recall.ts";
import type { ActivitySource } from "./run.ts";
import type { SearchHit } from "./search.ts";
import type { Vault } from "./vault.ts";

/** A day: what is read of a chat begins at the start of the operator's day before this one, at the latest its last cut. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Where a live conversation's id begins: never an episode's, whose ids begin with their day. */
export const LIVE_ID = "live-";
/** At most this many conversations: the newest. */
const LIVE_MAX = 4;
const log = createLogger("memory.live");

/** A chat key as part of an id: its letters and digits. */
const slugOfChat = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A scheduled job's conversation is its run log, filed from its report, as the cut leaves it (`run.ts`). */
const JOB_CHAT = /^cron:/;

/**
 * The conversations since each chat's last cut that `audience` may see, other than its own chat's (`exclude`), newest
 * first. In a group, none: a group sees its own conversations only, and its own talk is in its turn's history.
 */
export function liveEpisodes(
  deps: { source: ActivitySource; index: Pick<MemoryIndexPort, "lastEndedAt" | "groups">; vault: Vault; people: readonly Person[]; timeZone: string },
  audience: Audience,
  now: number,
  exclude?: string,
): Episode[] {
  if (audience.kind !== "dm") return [];
  // Yesterday's and today's, in the operator's days: where the nightly pass is off nothing is cut, and a chat's whole
  // history was read every turn. A start that moves once a day keeps each conversation's first piece, and its id, still.
  const since = startOfLocalDay(now - DAY_MS, deps.timeZone);
  const found: Episode[] = [];
  for (const chat of deps.source.chatsActiveSince(since)) {
    if (JOB_CHAT.test(chat.chatId) || isMissionChat(chat)) continue;
    const key = memoryChatKey(chat.gatewayId, chat.chatId);
    if (key === exclude || key === audience.chat) continue;
    try {
      // From where the cut would start, never before what was deleted from it, and not before yesterday.
      const ended = deps.index.lastEndedAt(key);
      const after = Math.max(ended === null ? 0 : ended + WITHIN_THE_SECOND_MS, deletedUpToNow(deps.vault, key) ?? 0, since);
      if (deps.source.exchangesBetween(chat.gatewayId, chat.chatId, after, now).length === 0) continue;
      const { kind, entries } = entriesOf(deps.source, deps.people, chat, after, now);
      const group = kind === "group" ? (deps.index.groups().get(key) ?? groupSlugFor(chat.gatewayId, chat.chatId)) : undefined;
      const pieces = episodesOf({ chat, kind, entries: withoutStaleOpening(entries), timeZone: deps.timeZone, ...(group ? { group } : {}), taken: (id) => fileExistsSync(deps.vault.episode(id)) });
      // Named by its chat as well: two chats whose talk began in the same minute with one agent got one id.
      for (const episode of pieces) if (canSeeEpisode(episode, audience)) found.push({ ...episode, id: `${LIVE_ID}${slugOfChat(key)}-${episode.id}` });
    } catch (err) {
      // One chat that cannot be read is left out, and the rest are read: recall runs on every turn.
      log.warn("another chat's talk could not be read for this turn", { chat: key, error: String(err) });
    }
  }
  // By when each began, newest first, never by its latest line: the prompt's memory block is cached, and an order that
  // moved with every message in another chat would have thrown that cache away each time.
  return found.sort((a, b) => Date.parse(b.started) - Date.parse(a.started)).slice(0, LIVE_MAX);
}

/** As the prompt's list of conversations not summarized yet names one (`Recall.waiting`): its first line, unread past it. */
export function asWaiting(episode: Episode, agentId: string, timeZone: string): Recall["waiting"][number] {
  const row = indexedEpisode(episode);
  return { id: row.id, day: row.day, time: localTime(row.startedAt, timeZone).time, agents: row.agents, preview: row.preview ?? "", theirs: row.agents.length > 0 && !row.agents.includes(agentId) };
}

/**
 * Those a search's words are in, as its hits, within its dates, people and agents: words as said, since a conversation
 * not cut keeps its own language. Ahead of what memory holds, being newer than any of it.
 */
export function liveHits(episodes: readonly Episode[], query: { query: string; since?: string; until?: string; people?: readonly string[]; agents?: readonly string[] }): SearchHit[] {
  // Whole words of four letters or more, at least half of them said there: a short or common word ("the", "what")
  // matched nearly every conversation, and those were put ahead of what the index had found.
  const words = [...new Set(query.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4))];
  if (words.length === 0) return [];
  const said = (episode: Episode) => new Set(episode.transcript.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return episodes
    .filter((episode) => (!query.since || episode.day >= query.since) && (!query.until || episode.day <= query.until))
    .filter((episode) => !query.people?.length || query.people.some((person) => episode.people.includes(person)))
    .filter((episode) => !query.agents?.length || query.agents.some((agent) => episode.agents.includes(agent)))
    .filter((episode) => {
      const in_ = said(episode);
      return words.filter((word) => in_.has(word)).length >= Math.ceil(words.length / 2);
    })
    .map((episode) => ({ kind: "episode" as const, episode: indexedEpisode(episode), score: 1 }));
}
