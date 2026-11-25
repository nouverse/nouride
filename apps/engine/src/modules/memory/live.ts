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
import { localTime } from "@/commons/clock.ts";
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

/** Chats active within this long are read: the nightly pass cuts a day's talk, so a day is what can be uncut. */
const LIVE_WINDOW_MS = 26 * 60 * 60 * 1000;
/** At most this many conversations: the newest. */
const LIVE_MAX = 4;
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
  const found: Episode[] = [];
  for (const chat of deps.source.chatsActiveSince(now - LIVE_WINDOW_MS)) {
    if (JOB_CHAT.test(chat.chatId) || isMissionChat(chat)) continue;
    const key = memoryChatKey(chat.gatewayId, chat.chatId);
    if (key === exclude || key === audience.chat) continue;
    // From where the cut would start, never before what was deleted from it.
    const ended = deps.index.lastEndedAt(key);
    const after = Math.max(ended === null ? 0 : ended + WITHIN_THE_SECOND_MS, deletedUpToNow(deps.vault, key) ?? 0);
    if (deps.source.exchangesBetween(chat.gatewayId, chat.chatId, after, now).length === 0) continue;
    const { kind, entries } = entriesOf(deps.source, deps.people, chat, after, now);
    const group = kind === "group" ? (deps.index.groups().get(key) ?? groupSlugFor(chat.gatewayId, chat.chatId)) : undefined;
    const pieces = episodesOf({ chat, kind, entries: withoutStaleOpening(entries), timeZone: deps.timeZone, ...(group ? { group } : {}), taken: (id) => fileExistsSync(deps.vault.episode(id)) });
    found.push(...pieces.filter((episode) => canSeeEpisode(episode, audience)));
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
 * Those a search's words are in, as its hits, within its dates, people and agents: a word of three letters or more,
 * as said, since a conversation not cut keeps its own language. Ahead of what memory holds, being newer than any of it.
 */
export function liveHits(episodes: readonly Episode[], query: { query: string; since?: string; until?: string; people?: readonly string[]; agents?: readonly string[] }): SearchHit[] {
  const words = query.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  return episodes
    .filter((episode) => (!query.since || episode.day >= query.since) && (!query.until || episode.day <= query.until))
    .filter((episode) => !query.people?.length || query.people.some((person) => episode.people.includes(person)))
    .filter((episode) => !query.agents?.length || query.agents.some((agent) => episode.agents.includes(agent)))
    .filter((episode) => words.length === 0 || words.some((word) => episode.transcript.toLowerCase().includes(word)))
    .map((episode) => ({ kind: "episode" as const, episode: indexedEpisode(episode), score: 1 }));
}
