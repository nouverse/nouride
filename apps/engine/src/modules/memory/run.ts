/**
 * Cutting chats and running the nightly pass — the order things happen in (`docs/SPEC.md` §12.2).
 *
 * A cut reads a chat's turns and room messages since it was last cut — where the vault says the chat's
 * latest episode ended — and writes the episodes, so a cut that runs twice cuts once (`cutChat`). A
 * turn still running is left for the next cut: its answer is not written yet.
 *
 * The pass: sync the index with the files, cut every chat active since its last cut, file the raw
 * episodes (direct conversations first, oldest first, `pass_per_night` per agent), compact what is
 * past `transcript_days`, and rewrite the day hubs that changed.
 */

import { isMissionChat } from "@/modules/missions/gateway.ts";
import { fileExistsSync } from "@nouride/runtime";
import { createLogger, type MemorySection, type Person } from "@nouride/shared";
import { memoryChatKey } from "./access.ts";
import { isoWeek, localTime, safeTimeZone } from "@/commons/clock.ts";
import { entriesOf, episodesOf, groupSlugFor, withoutStaleOpening, type ChatSource } from "./cut.ts";
import { deletedUpTo } from "./deleted.ts";
import { WITHIN_THE_SECOND_MS, type Episode } from "./episode.ts";
import { creatingEpisodes, readEpisode } from "./episodes.ts";
import { ensureStubs, pruneTagStubs } from "./graph.ts";
import { syncIndex } from "./index-sync.ts";
import { tidyProfiles } from "./consolidate.ts";
import { compactEpisodes, refreshDays, restoreArchived } from "./maintain.ts";
import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import type { IndexedEpisode, MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import { fileEpisode, type PassDeps } from "./pass.ts";
import { factsModeFor, nameOf } from "./people.ts";
import { applyWaiting } from "./proposals.ts";
import { tagBook } from "./tag-book.ts";
import type { Vault } from "./vault.ts";
import { writeEpisode } from "./write.ts";

const log = createLogger("memory");

/** Chats that are a scheduled job's own, not anybody's conversation (`cron/scheduler.ts`). */
const JOB_CHAT = /^cron:/;

export interface ActivitySource extends ChatSource {
  chatsActiveSince(after: number): { gatewayId: string; chatId: string; runningSince: number | null }[];
}

export interface RunDeps {
  vault: Vault;
  index: MemoryIndexPort;
  analytics: Pick<MemoryAnalyticsPort, "tagUse" | "taggedIn" | "chatTags" | "tagCounts">;
  state: MemoryStatePort;
  source: ActivitySource;
  config: { memory: MemorySection; people: Person[] };
  timeZone: string;
  now: () => number;
  semantic?: PassDeps["semantic"];
}

/**
 * Cut one chat up to `until`. Returns the episodes written. `runningSince` is when the chat's first turn
 * still running began, when the caller already knows; otherwise it is looked up.
 *
 * It starts where the chat was last cut, which the vault says: the later of where its latest episode
 * ended and where the latest one deleted from it did (`deleted.ts`). That is exact because a cut never
 * files past where it stops: it stops before a turn still running, and before a turn that began by then
 * but finished after (two agents answering in one group at once) — so a chat's latest episode never
 * ends past where it was cut, and a cut that runs twice cuts once. A cursor in the database said the
 * same a second time, and was the half a restore or a crash between the two could leave behind: each
 * cut the same stretch again and filed it as `…-2`, at a model call a copy.
 *
 * One cut at a time, with every other writer of new episodes (`creatingEpisodes`): `/new` in a chat
 * while the nightly pass cuts it would otherwise both start from the same place.
 */
export async function cutChat(deps: RunDeps, chat: { gatewayId: string; chatId: string }, until: number, runningSince?: number | null): Promise<Episode[]> {
  // A mission's conversation is its work log: what lasts of it is filed once, from its report, when it ends (0.8.0).
  if (JOB_CHAT.test(chat.chatId) || isMissionChat(chat)) return [];
  const key = memoryChatKey(chat.gatewayId, chat.chatId);
  return await creatingEpisodes(deps.vault, async () => {
    // Never from before where the vault says, even where that is past this cut — a clock set back on a box with none of
    // its own, an `ended` moved forward by hand: nothing is cut until time passes it, rather than all of it a second
    // time. A cursor in the database once stood behind this. `ended` is written to the second, and the line it ends on
    // may be later in that second.
    const ended = deps.index.lastEndedAt(key);
    const after = Math.max(ended === null ? 0 : ended + WITHIN_THE_SECOND_MS, (await deletedUpTo(deps.vault, key)) ?? 0);
    const exchanges = deps.source.exchangesBetween(chat.gatewayId, chat.chatId, after, until);
    // No agent has said anything since, so there is no episode — and a group's talk is not read every night to find that out.
    if (exchanges.length === 0) return [];
    const running =
      runningSince !== undefined
        ? runningSince
        : (deps.source.chatsActiveSince(after).find((active) => active.gatewayId === chat.gatewayId && active.chatId === chat.chatId)?.runningSince ?? null);
    const stop = settledBy(exchanges, running === null ? until : Math.min(until, running - 1));
    if (stop <= after) return [];
    const { kind, entries } = entriesOf(deps.source, deps.config.people, chat, after, stop);
    const group = kind === "group" ? (deps.index.groups().get(key) ?? groupSlugFor(chat.gatewayId, chat.chatId)) : undefined;
    const episodes = episodesOf({
      chat,
      kind,
      entries: withoutStaleOpening(entries),
      timeZone: deps.timeZone,
      ...(group ? { group } : {}),
      taken: (id) => fileExistsSync(deps.vault.episode(id)),
    });
    // What each episode opened of the knowledge base, kept on its file: the memory graph joins them (0.8.23).
    const opened = deps.source.documentsOpenedBetween?.(chat.gatewayId, chat.chatId, after, stop) ?? [];
    for (const episode of episodes) {
      const documents = openedIn(opened, episode);
      if (documents.length) episode.documents = documents;
      await writeEpisode(deps, episode);
      await ensureStubs(deps.vault, episode);
    }
    if (group && episodes.length) deps.index.putGroup(key, group);
    return episodes;
  });
}

/** Documents one conversation opens at most, kept on it: past it a graph line says nothing a person reads. */
const DOCUMENTS_PER_EPISODE = 20;

/** The documents opened within an episode's time, once each, in the order first opened. Pure. */
function openedIn(opened: readonly { at: number; document: string }[], episode: Pick<Episode, "started" | "ended">): string[] {
  const from = Date.parse(episode.started);
  const to = Date.parse(episode.ended) + WITHIN_THE_SECOND_MS;
  const out: string[] = [];
  for (const { at, document } of opened) {
    if (at >= from && at <= to && !out.includes(document)) out.push(document);
  }
  return out.slice(0, DOCUMENTS_PER_EPISODE);
}

/**
 * Where a cut may stop: at `bound` — the time asked for, or just before a turn still running — moved back
 * before any turn that had begun by then and finished after it. Pure.
 */
export function settledBy(exchanges: readonly { startedAt: number; endedAt: number }[], bound: number): number {
  let stop = bound;
  for (;;) {
    const straddling = exchanges.find((exchange) => exchange.startedAt <= stop && exchange.endedAt > stop);
    if (!straddling) return stop;
    stop = straddling.startedAt - 1;
  }
}

/**
 * Cut every chat with a turn since its last cut. A chat that cannot be cut is logged and left for the
 * next cut, and the rest are cut: one chat stopped every chat after it, every night, until someone
 * found which.
 */
export async function cutActive(deps: RunDeps, until: number): Promise<{ episodes: Episode[]; problems: PassProblem[] }> {
  const episodes: Episode[] = [];
  const problems: PassProblem[] = [];
  for (const chat of deps.source.chatsActiveSince(0)) {
    try {
      episodes.push(...(await cutChat(deps, chat, until, chat.runningSince)));
    } catch (err) {
      problems.push({ what: `chat ${memoryChatKey(chat.gatewayId, chat.chatId)}`, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  if (problems.length) log.warn("chats that could not be cut, left for the next cut", { chats: problems.slice(0, 10) });
  return { episodes, problems };
}

/** The order the pass files in: direct conversations, then groups, then archives — what an import before 0.8.0 made. */
const KIND_ORDER = { dm: 0, group: 1, archive: 2 } as const;

/** The agent an episode is counted under for `pass_per_night`: its first, and none for one no agent had. */
export function countedUnder(episode: Pick<IndexedEpisode, "agents">): string {
  return episode.agents[0] ?? "";
}

/** Raw episodes the pass may still file — not given up on — direct conversations first, oldest first. */
export function passCandidates(deps: Pick<RunDeps, "index" | "state" | "config">): IndexedEpisode[] {
  return deps.index
    .withStatus("raw")
    .filter((episode) => deps.state.attempts(episode.id) < deps.config.memory.maxAttempts)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.startedAt - b.startedAt);
}

/** Raw episodes the pass would file tonight: not given up on, direct conversations first, capped per agent. */
function passQueue(deps: Pick<RunDeps, "index" | "state" | "config">): { queue: IndexedEpisode[]; waiting: number } {
  const order = KIND_ORDER;
  const candidates = passCandidates(deps);
  const perAgent = new Map<string, number>();
  const queue: IndexedEpisode[] = [];
  for (const episode of candidates) {
    const agent = countedUnder(episode);
    const taken = perAgent.get(agent) ?? 0;
    if (taken >= deps.config.memory.passPerNight) continue;
    perAgent.set(agent, taken + 1);
    queue.push(episode);
  }
  // Chosen by time, filed by chat: one audience's conversations back to back share a vocabulary, and so
  // a cached prompt prefix. Which episodes tonight takes does not change; only the order it files them in.
  const firstOf = new Map<string, number>();
  for (const [i, episode] of queue.entries()) if (!firstOf.has(episode.chat)) firstOf.set(episode.chat, i);
  queue.sort((a, b) => order[a.kind] - order[b.kind] || firstOf.get(a.chat)! - firstOf.get(b.chat)! || a.startedAt - b.startedAt);
  return { queue, waiting: candidates.length - queue.length };
}

/** Something the pass passed over and went on without: a file it could not read, a chat it could not cut, a day hub it could not draw. */
export interface PassProblem {
  what: string;
  problem: string;
}

export interface PassReport {
  cut: number;
  filed: number;
  failed: { episode: string; reason: string }[];
  /** What it passed over and went on without — each logged where it happened, and named here for a person. */
  problems: PassProblem[];
  applied: number;
  proposed: number;
  dropped: number;
  /** Profiles tidied because they outgrew what is shown of them — `consolidate.ts`. */
  tidied: number;
  compacted: number;
  /** Compacted episodes given their transcript back from the archive, while transcripts are kept forever. */
  restored: number;
  waiting: number;
  /** What the tag gate did tonight — `tags.ts:fileTags`. A night coining tags for a third of what it filed is drifting. */
  tags: { reused: number; folded: number; created: number; dropped: number; stubsRemoved: number };
  /** Each tag coined tonight, with the known tag the model judged nearest — the morning review's list. */
  newTags: { tag: string; episode: string; closest?: string }[];
  /** Why the pass stopped early, when it did — today's budget, most often. */
  stopped?: string;
}

/**
 * Whether this pass is the week's first — its day in another ISO week than the last pass that finished —
 * and so the one that rewrites the word index whole. Counted from the record, not a weekday, so a week whose
 * Sunday the daemon was off still gets one. Pure.
 */
export function firstPassOfWeek(lastFinished: string | null, today: string): boolean {
  return lastFinished === null || isoWeek(lastFinished) !== isoWeek(today);
}

/**
 * `stop`, read before each conversation, ends the night early with its reason. `room`, awaited before each — and before
 * `stop`, which a wait may have changed — is the scheduled night's wait while the box is busy (0.8.0,
 * `boot/memory-pass.ts`); a pass asked for by hand has none.
 */
export async function runPass(deps: RunDeps, options: { ask: PassDeps["ask"]; stop?: () => string | null; room?: () => Promise<unknown> }): Promise<PassReport> {
  const synced = await syncIndex(deps.vault, deps.index);
  const cut = await cutActive(deps, deps.now());
  const report: PassReport = {
    cut: cut.episodes.length, filed: 0, failed: [], applied: 0, proposed: 0, dropped: 0, tidied: 0, compacted: 0, restored: 0, waiting: 0,
    problems: [...synced.problems.map((found) => ({ what: found.file, problem: found.problem })), ...cut.problems],
    tags: { reused: 0, folded: 0, created: 0, dropped: 0, stubsRemoved: 0 },
    newTags: [],
  };
  const days = new Set(cut.episodes.map((episode) => episode.day));

  // Changes left waiting while someone's `facts` was "ask" are kept once it is "auto" again.
  const auto = (subject: string) => factsModeFor(deps.config, subject) === "auto";
  report.applied += await applyWaiting(deps, auto);

  const { queue, waiting } = passQueue(deps);
  report.waiting = waiting;
  const tags = tagBook({ analytics: deps.analytics, index: deps.index, now: deps.now });
  const passDeps: PassDeps = { vault: deps.vault, index: deps.index, tags, state: deps.state, config: deps.config, ask: options.ask, now: deps.now, ...(deps.semantic ? { semantic: deps.semantic } : {}) };
  for (const [position, queued] of queue.entries()) {
    await options.room?.();
    const stopped = options.stop?.();
    if (stopped) {
      report.stopped = stopped;
      report.waiting += queue.length - position;
      break;
    }
    const episode = await readEpisode(deps.vault, queued.id);
    if (!episode || episode.status !== "raw") continue;
    // A conversation that throws is a failed attempt like an unusable answer — counted, so one that
    // throws every night is given up on and listed for a person — and the next one is filed.
    const outcome = await fileEpisode(passDeps, episode).catch((err: unknown) => ({ status: "failed" as const, reason: err instanceof Error ? err.message : String(err), unreachable: false }));
    if (outcome.status === "failed") {
      // Only an answer that could not be used counts as an attempt at this conversation.
      if (!outcome.unreachable) deps.state.recordFailure(episode.id, outcome.reason, deps.now());
      report.failed.push({ episode: episode.id, reason: outcome.reason });
      continue;
    }
    // Deleted while its model was asked: there is nothing left to file, and nothing it taught was kept.
    if (outcome.status === "gone") continue;
    deps.state.clearAttempts(episode.id);
    report.filed += 1;
    report.applied += outcome.applied;
    report.proposed += outcome.proposed;
    report.dropped += outcome.dropped;
    report.tags.reused += outcome.tags.reused;
    report.tags.folded += outcome.tags.folded;
    report.tags.created += outcome.tags.created.length;
    report.tags.dropped += outcome.tags.dropped;
    for (const tag of outcome.tags.created) report.newTags.push({ tag, episode: episode.id, ...(outcome.tags.closest ? { closest: outcome.tags.closest } : {}) });
    days.add(episode.day);
  }

  // After filing, so what tonight taught is tidied with the rest. Only profiles whose facts change on
  // their own: under `ask`, every change is a person's, and a rewrite of the whole profile would be one too.
  if (!report.stopped) {
    report.tidied = await tidyProfiles({
      auto,
      vault: deps.vault,
      index: deps.index,
      state: deps.state,
      names: (subject) => nameOf(deps.config.people, subject),
      ask: options.ask,
      now: deps.now,
      today: localTime(deps.now(), safeTimeZone(deps.timeZone)).day,
      ...(options.stop ? { stop: options.stop } : {}),
    });
  }

  // `0` keeps every transcript: nothing is past its days, so nothing is compacted — and what was
  // compacted before, under days, gets its transcript back from the archive.
  const keep = deps.config.memory.transcriptDays;
  if (keep === 0) {
    const restored = await restoreArchived({ vault: deps.vault, index: deps.index });
    report.restored = restored.restored;
    for (const day of restored.days) days.add(day);
  } else {
    const compacted = await compactEpisodes({ vault: deps.vault, index: deps.index, before: deps.now() - keep * 86_400_000, archive: deps.config.memory.archive });
    report.compacted = compacted.compacted;
    for (const day of compacted.days) days.add(day);
  }
  for (const unwritten of await refreshDays(deps.vault, deps.index, days)) report.problems.push({ what: `day ${unwritten.day}`, problem: unwritten.problem });
  // A night of writes leaves FTS5 a segment per batch. A bounded merge folds them in; the whole index is
  // rewritten into one b-tree once a week, not every night for twenty documents (E12).
  deps.index.optimizeText(firstPassOfWeek(deps.state.lastFinishedRun()?.day ?? null, localTime(deps.now(), safeTimeZone(deps.timeZone)).day));
  // A stub whose tag no longer has two episodes goes, if nobody wrote in it — it comes back on a second use.
  report.tags.stubsRemoved = await pruneTagStubs(deps.vault, deps.analytics.tagCounts().counts);
  return report;
}
