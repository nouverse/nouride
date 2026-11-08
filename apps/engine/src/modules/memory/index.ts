/**
 * Memory — the module's one surface (`docs/SPEC.md` §12).
 *
 * Everything outside `modules/memory` — the tools, the prompt, the hooks, the control API, the MCP
 * server, the CLI, the nightly clock — talks to the object `createMemory` returns, and to the few
 * names exported below for what runs without one: the CLI and the config check find a vault and check
 * its format, back it up and rename a gateway in it; the memory tools hold a write to English;
 * the MCP surface caps a saved conversation. Nothing outside this directory imports one of its files
 * by path — `lint:arch` refuses it (`memory-past-its-barrel`), except boot and the daemon's
 * `index.ts`, which build the stores this module is given. So the access rule, the vault's layout and
 * the index are each decided once, here, and a change inside this directory that breaks a caller
 * shows at this file.
 *
 * Built once at boot from the live config object: `[memory]` and `[[people]]` are read on every call,
 * so a person named mid-conversation is known from the next turn.
 */

import { dirname, join } from "@nouride/runtime";
import { createLogger, type ChatType, type MemorySection, type MemorySemanticSection, oneLine, type Person } from "@nouride/shared";
import { audienceOf, canSeeEpisode, canSeeFact, memoryChatKey, scopeOf, type Audience } from "./access.ts";
import { analyze, type AnalyzeRequest } from "./analyze.ts";
import { passBacklog, type PassBacklog } from "./backlog.ts";
import { localTime } from "@/commons/clock.ts";
import type { Episode } from "./episode.ts";
import { readEpisode } from "./episodes.ts";
import { syncIndex, type SyncReport } from "./index-sync.ts";
import { createManagement } from "./manage.ts";
import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import type { IndexedEpisode, MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import type { MemoryVectorPort } from "./memory-vectors.store.ts";
import type { PassDeps } from "./pass.ts";
import { pruneTagStubs } from "./graph.ts";
import { withKnowledge, type GraphFilter, type MemoryGraph } from "./graph-view.ts";
import { createTagTools } from "./memory-tags.ts";
import { archiveSize } from "./maintain.ts";
import { identityOf, personOf } from "./people.ts";
import type { FactOperation, Readers } from "./profile.ts";
import { recallFor, type Recall } from "./recall.ts";
import { cutActive, cutChat, runPass, type ActivitySource, type PassReport, type RunDeps } from "./run.ts";
import { saveConversation, type SaveRequest } from "./saved.ts";
import { searchMemory, type SearchHit } from "./search.ts";
import { catchUp, parseVectorKey, rankingModel, rankingVectors, vectorKey, type CatchUpReport, type Embedder, type Semantic } from "./semantic.ts";
import { vaultAt } from "./vault.ts";
import { editProfile } from "./write.ts";
import { idsOf } from "@/modules/people/match.ts";
import type { Collection } from "./knowledge/collections.ts";
import { createKnowledge, type KeepRequest, type KeepResult, type KnowledgeDeps } from "./knowledge/surface.ts";

export type { Recall, RecalledFact } from "./recall.ts";

// What runs without a `Memory` — the CLI, the config check, the tools, the MCP surface, the control routes.
export { SHARED, vaultAt } from "./vault.ts";
export { checkVaultFormat, readVaultFormat, VaultFormatError } from "./format.ts";
export { backupKnowledge, backupVault, newestKnowledgeBackupAt, vaultBackupDir } from "./backup.ts";
export { KnowledgeStore } from "./knowledge/knowledge.store.ts";

/** The knowledge base's folder: `.nouride/knowledge/`, beside the install's data (KNOWLEDGE_BASE §4). */
export function knowledgeDirOf(dataDir: string): string {
  return join(dirname(dataDir), "knowledge");
}
export { applyVaultRename, planVaultRename, type VaultRename } from "./rename.ts";
export { SAVED_MAX_CHARS, type SavedTurn } from "./saved.ts";
export { memoryTextIsEnglish, workTextIsEnglish, writeWorkInEnglish, WRITE_IN_ENGLISH } from "./english.ts";
export type { AnalyzeField, AnalyzeRequest } from "./analyze.ts";
export type { Period } from "./memory-analytics.store.ts";
export type { EpisodeStatus } from "./episode.ts";
export type { TidyChange } from "./tidy.ts";
export type { PassBacklog } from "./backlog.ts";
export type { Collection, CollectionSettings, KnowledgeReaders } from "./knowledge/collections.ts";
export { TITLE_MAX } from "./knowledge/collections.ts";
export type { IndexedSection, KnowledgeDocument } from "./knowledge/knowledge.store.ts";
export type { KnowledgeSyncReport } from "./knowledge/sync.ts";
export type { CollectionView, KeepRequest, KeepResult, KnowledgeDeps } from "./knowledge/surface.ts";
export type { PendingDocument } from "./knowledge/files.ts";
export { collectionIdOf } from "./knowledge/files.ts";

const log = createLogger("memory");
export type { SearchHit } from "./search.ts";

/** Who is speaking, in which chat, to which agent — what every question here starts from. */
export interface Speaker {
  agentId: string;
  gatewayId: string;
  senderId: string;
  chatId: string;
  chatType: ChatType;
}

/** Days looked back when an analysis names no range: a month for a ranking, a quarter for a trend. */
const ANALYZE_WINDOW_DAYS: Record<AnalyzeRequest["intent"], number> = { top: 30, activity: 30, importance: 30, count: 90, dates: 3650 };

/**
 * How long the model before a change is left alone after it failed to embed a query: searches meanwhile rank by the
 * model in use (M7). A quarter of an hour — a provider back up is used again soon, one gone costs a call that often.
 */
const RETRY_BEFORE_MS = 15 * 60_000;

export interface MemoryDeps {
  /** The live config: read on every call, never copied. */
  config: { memory: MemorySection; people: Person[]; daemon: { timezone: string } };
  index: MemoryIndexPort;
  analytics: MemoryAnalyticsPort;
  state: MemoryStatePort;
  /** The turn and room logs, as memory reads them (boot adapts the stores). */
  source: ActivitySource;
  /** Who has been speaking in a group lately, by sender id — whose profiles its prompt carries. */
  speakersIn?: (gatewayId: string, chatId: string) => string[];
  vectors?: MemoryVectorPort;
  embed?: (semantic: MemorySemanticSection, texts: string[]) => Promise<number[][] | null>;
  now?: () => number;
  /** The knowledge base (0.8.20): its folder, its index, and who the admins are, by person key. */
  knowledge?: KnowledgeDeps;
}

export function createMemory(deps: MemoryDeps) {
  const { config, index, analytics, state } = deps;
  const vault = vaultAt(config.memory.dir);
  const now = deps.now ?? Date.now;
  const timeZone = () => config.daemon.timezone;
  const runDeps = (): RunDeps => ({ vault, index, analytics, state, source: deps.source, config, timeZone: timeZone(), now });

  /** The catch-up in flight, if one is: the pass and a person pressing Embed now both start one. */
  let catchingUp: Promise<CatchUpReport | null> | null = null;
  let lastEmbed: { ok: boolean; at: number } | null = null;
  /** Keys whose model last failed to embed a query, and when: not asked again until `RETRY_BEFORE_MS` has passed. */
  const failedBefore = new Map<string, number>();

  function embedder(): Embedder | null {
    const semantic = config.memory.semantic;
    if (!semantic.enabled || !deps.embed || !deps.vectors) return null;
    const embed = deps.embed;
    return {
      model: vectorKey(semantic),
      embed: async (texts) => {
        const vectors = await embed(semantic, texts);
        lastEmbed = { ok: vectors !== null, at: now() };
        return vectors;
      },
    };
  }

  /**
   * The model another vector key names, asked through the provider the key names — what ranks a search while a change of
   * model is caught up (M7). Null for a key that names no size, and for a while after it failed: a provider removed or
   * unreachable would otherwise cost every search a failed call before the model in use answered it.
   */
  function embedderFor(key: string): Embedder | null {
    const named = parseVectorKey(key);
    const embed = deps.embed;
    if (!named || !embed) return null;
    const failed = failedBefore.get(key);
    if (failed !== undefined && now() - failed < RETRY_BEFORE_MS) return null;
    return {
      model: key,
      embed: async (texts) => {
        const vectors = await embed({ ...config.memory.semantic, ...named }, texts);
        if (vectors) failedBefore.delete(key);
        else failedBefore.set(key, now());
        return vectors;
      },
    };
  }

  /** Search by meaning as it stands: the model in use, its vectors, and the model before it while that one still ranks. */
  function semanticNow(): Semantic | null {
    const current = embedder();
    return current && deps.vectors ? { vectors: deps.vectors, embedder: current, embedderFor } : null;
  }

  /** Who is asking, and what the chat they ask from may see. */
  function situate(speaker: Speaker): { identity: string; person: { key: string; name: string } | null; audience: Audience } {
    const sender = { gatewayId: speaker.gatewayId, senderId: speaker.senderId };
    const identity = identityOf(config.people, sender);
    const entry = personOf(config.people, sender);
    const present = speaker.chatType === "dm" ? [] : (deps.speakersIn?.(speaker.gatewayId, speaker.chatId) ?? []).map((senderId) => identityOf(config.people, { gatewayId: speaker.gatewayId, senderId }));
    return {
      identity,
      person: entry?.key ? { key: entry.key, name: entry.name } : null,
      audience: audienceOf({ chat: memoryChatKey(speaker.gatewayId, speaker.chatId), chatType: speaker.chatType, person: identity, present }),
    };
  }

  const management = createManagement({ vault, index, analytics, state, ...(deps.vectors ? { vectors: deps.vectors } : {}), config, now, cutAll: () => cutActive(runDeps(), now()) });

  /**
   * One maintenance job at a time — the pass, a reindex, a forget, a tag tidy: each rewrites
   * files the others read. A job waits for the one before it; a tidy, asked for by a person, is refused
   * instead. The smaller writes that run beside a job — deleting a conversation, deciding a proposal, a
   * conversation saved over MCP — are kept from it by the locks of the files they share (`write.ts`,
   * `episodes.ts`, `proposals.ts`), not by waiting for a pass that may take minutes.
   */
  let job: { what: string; done: Promise<unknown> } | null = null;
  async function exclusive<T>(what: string, work: () => Promise<T>): Promise<T> {
    while (job) await job.done.catch(() => undefined);
    const done = work();
    job = { what, done };
    try {
      return await done;
    } finally {
      if (job?.done === done) job = null;
    }
  }
  const tags = createTagTools({ vault, index, analytics, now, busy: () => job?.what ?? null, exclusive });

  /** `room`, awaited before each batch — `catchUp`. A catch-up already running is joined as it is. */
  async function embedCatchUp(room?: () => Promise<unknown>): Promise<CatchUpReport | null> {
    const semantic = embedder();
    const vectors = deps.vectors;
    if (!semantic || !vectors) return null;
    const knowledge = deps.knowledge;
    catchingUp ??= (async () => {
      try {
        return await catchUp({ index, vectors, embedder: semantic, now, ...(room ? { room } : {}), ...(knowledge ? { sections: () => knowledge.store.embeddable() } : {}) });
      } catch (err) {
        // Said here, once, for every caller: two of them start it in the background and cannot wait to hear. A
        // provider that fails is not this — the embedder says so and the catch-up reports `failed` — but a
        // database or an index that throws was nowhere in the log.
        log.warn("memory embedding catch-up failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        catchingUp = null;
      }
    })();
    return await catchingUp;
  }
  /** People's names for their keys, as a collection's `about` lists them: what the model reads is who, not a key. */
  const namesOf = (keys: readonly string[]) => keys.map((key) => config.people.find((person) => person.key === key)?.name ?? key);
  /** Who is asking, as the knowledge base reads it: the agent, and what the chat may see. */
  const who = (speaker: Speaker) => ({ agentId: speaker.agentId, audience: situate(speaker).audience });
  const knowledge = createKnowledge({ ...(deps.knowledge ? { knowledge: deps.knowledge } : {}), now, semantic: semanticNow, embeds: () => embedder() !== null, embedCatchUp });


  return {
    // ─── in a chat ───

    recall(speaker: Speaker): Recall {
      const semantic = semanticNow();
      const recall = recallFor({ index, people: config.people, audience: situate(speaker).audience, agentId: speaker.agentId, recent: config.memory.promptRecent, recall: config.memory.recall, timeZone: timeZone(), now: now(), ...(semantic ? { vectors: rankingVectors(semantic) } : {}) });
      // The collections it may search here, by name: never their documents (§9).
      return {
        ...recall,
        knowledge: knowledge.usable(who(speaker)).map((collection) => ({
          name: collection.settings.name,
          description: collection.settings.description,
          ...(collection.settings.about.length ? { about: namesOf(collection.settings.about) } : {}),
        })),
      };
    },

    async search(speaker: Speaker, query: { query: string; since?: string; until?: string; people?: string[]; agents?: readonly string[]; limit?: number; kind?: "knowledge" }): Promise<SearchHit[]> {
      const semantic = semanticNow();
      const { kind, ...asked } = query;
      const scopes = knowledge.usable(who(speaker)).map((collection) => ({ id: collection.id, name: collection.settings.name, about: collection.settings.about }));
      const hits = await searchMemory(
        { index, people: config.people, now, timeZone: timeZone(), ...(semantic ? { semantic } : {}), ...(deps.knowledge ? { knowledge: deps.knowledge.store } : {}) },
        { audience: situate(speaker).audience, ...asked, knowledge: scopes },
      );
      return kind === "knowledge" ? hits.filter((hit) => hit.kind === "section") : hits;
    },

    /** A knowledge section, or (`#all`) its whole document, if this agent may search its collection here. */
    readKnowledge: (speaker: Speaker, item: string) => {
      const read = knowledge.read(who(speaker), item);
      return "refused" in read ? read : { ...read, about: namesOf(read.about) };
    },

    analyze(speaker: Speaker, request: AnalyzeRequest, range: { since?: string; until?: string; agents?: readonly string[] } = {}): string {
      const since = range.since ?? localTime(now() - ANALYZE_WINDOW_DAYS[request.intent] * 86_400_000, timeZone()).day;
      const filter = {
        scope: scopeOf(situate(speaker).audience),
        since,
        ...(range.until ? { until: range.until } : {}),
        ...(range.agents?.length ? { agents: range.agents } : {}),
      };
      return analyze(analytics, filter, request, range.until ? `from ${since} to ${range.until}` : `since ${since}`);
    },

    /** One episode, if this chat may see it — its transcript while kept, else its summary. */
    async read(speaker: Speaker, id: string): Promise<Episode | { refused: string }> {
      const episode = await readEpisode(vault, id);
      if (!episode || !canSeeEpisode(episode, situate(speaker).audience)) return { refused: `no conversation "${id}" that this chat may see` };
      return episode;
    },

    /**
     * The conversations next to one — one hop over the edges the index already holds: those it links
     * as `related`, then those sharing its people and tags, closest first. Each through the same rule as
     * any episode, so a neighbour this chat may not see is not there. No model call and no vectors, so
     * it works the same on a fresh install (after Basic Memory's `build_context`).
     *
     * `agents` bounds it as it bounds a search: an MCP token names the agents it may read, and a neighbour
     * none of them had is not one of its conversations, whoever took part.
     */
    nearby(speaker: Speaker, episode: Episode, within: { agents?: readonly string[] } = {}, limit = 5): IndexedEpisode[] {
      const scope = scopeOf(situate(speaker).audience);
      const byShared = index.neighbours({ id: episode.id, people: episode.people, tags: episode.tags, since: 0 }, limit * 2).map((hit) => hit.id);
      const order = [...new Set([...episode.related, ...byShared])].filter((id) => id !== episode.id);
      if (order.length === 0) return [];
      const filter = { scope, ids: order, ...(within.agents?.length ? { agents: within.agents } : {}) };
      const visible = new Map(index.episodes(filter, order.length).map((found) => [found.id, found]));
      return order.flatMap((id) => visible.get(id) ?? []).slice(0, limit);
    },

    /**
     * Keep, correct or drop something about the speaker, now — `memory_write` with about=person. What
     * is written is stamped with this chat's audience, so it is readable where this conversation is;
     * a fact to correct or drop is named by its words, and only one this chat may read can be touched.
     */
    async noteAboutSpeaker(
      speaker: Speaker,
      change: { op: "add"; section: string; text: string } | { op: "update"; current: string; text: string } | { op: "remove"; current: string },
    ): Promise<{ status: "written" | "unchanged" } | { refused: string }> {
      const { person, identity, audience } = situate(speaker);
      if (!person) return { refused: "The person you are talking to has no profile yet. If you know their name, record them with `person_record` first, then call this again. If you do not, keep it only for this conversation: do not put it in MEMORY.md." };
      const readers: Readers = audience.kind === "dm" ? { people: [identity] } : { people: [...audience.present], chat: audience.chat };
      const same = (a: string, b: string) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();
      const result = await editProfile({ vault, index, state, now }, person.key, {
        operations: (facts): FactOperation[] | { refused: string } => {
          if (change.op === "add") return [change];
          const fact = facts.find((candidate) => same(candidate.text, change.current) && canSeeFact(candidate, person.key, audience));
          if (!fact) return { refused: `No fact reading "${change.current}" is known here. Use the words exactly as they appear under what you know about them.` };
          return [change.op === "update" ? { op: "update", n: fact.n, text: change.text } : { op: "remove", n: fact.n }];
        },
        provenance: { readers },
        cause: "agent",
        name: person.name,
      });
      return result.status === "refused" ? { refused: result.reason } : { status: result.status };
    },

    /** Cut this chat into episodes now — `/new` and `/reset`. */
    async cut(gatewayId: string, chatId: string): Promise<number> {
      return (await cutChat(runDeps(), { gatewayId, chatId }, now())).length;
    },

    // ─── other tools, over MCP ───

    /**
     * The speaker a person is when they reach memory from outside a chat. Built from one of their own
     * `[[people]]` ids, so they are recognised exactly as when they message an agent, and the audience
     * is their DM: what they took part in, nothing more. Null for a key nobody has.
     */
    speakerFor(personKey: string, agentId: string, label: string): Speaker | null {
      const entry = config.people.find((candidate) => candidate.key === personKey);
      if (!entry) return null;
      for (const id of idsOf(entry)) {
        const parts = id.split(":");
        if (parts.length < 2 || parts.some((part) => !part)) continue;
        const [gatewayId, senderId] = parts.length === 2 ? [`${parts[0]}:mcp`, parts[1]!] : [`${parts[0]}:${parts[1]}`, parts.slice(2).join(":")];
        return { agentId, gatewayId, senderId, chatId: `mcp:${label}`, chatType: "dm" };
      }
      return null;
    },

    /** A conversation another tool saves, condensed, as a raw episode filed tonight — `saved.ts`. */
    async saveConversation(request: SaveRequest): Promise<{ saved: string[]; replaced: number } | { refused: string }> {
      return await saveConversation({ vault, index, state, ...(deps.vectors ? { vectors: deps.vectors } : {}), people: config.people, timeZone: timeZone(), now }, request);
    },

    // ─── the nightly pass ───

    /** Whether the pass runs at all: `[memory] pass`, which the setup wizard asks about. */
    passing(): boolean {
      return config.memory.pass;
    },

    /** `stop` and `room` are read before each conversation — `runPass`. */
    async pass(ask: PassDeps["ask"], stop?: () => string | null, room?: () => Promise<unknown>): Promise<PassReport> {
      const semantic = semanticNow();
      return await exclusive("the nightly pass", () => runPass({ ...runDeps(), ...(semantic ? { semantic } : {}) }, { ask, ...(stop ? { stop } : {}), ...(room ? { room } : {}) }));
    },

    /** Tags: the list, the tidy and its undo — `memory-tags.ts`. */
    tags,

    /** The pass's own record, kept across restarts — see `memory_pass_runs` in `069_baseline.sql`. */
    passRuns: {
      started: (run: { startedAt: number; day: string; scheduled: boolean }) => state.passStarted(run),
      finished: (id: string, report: unknown) => state.passFinished(id, now(), report),
      lastScheduledDay: () => state.lastScheduledDay(),
      hasScheduledRun: () => state.hasScheduledRun(),
      skipped: (run: { at: number; day: string }) => state.passSkipped(run),
      lastFinished: () => state.lastFinishedRun(),
    },

    /** What waits for the pass, and whether it keeps up with what each agent's conversations bring — `backlog.ts` (M4). */
    backlog(): PassBacklog {
      return passBacklog({ index, state, config, analytics }, now());
    },

    /** Cut every active chat without filing: the pass's first step, taken alone — what a test drives before it files. */
    async cutAll(): Promise<number> {
      return (await cutActive(runDeps(), now())).episodes.length;
    },

    async sync(): Promise<SyncReport> {
      return await syncIndex(vault, index);
    },

    // ─── the knowledge base (0.8.20) ───

    knowledge: {
      ...knowledge.surface,
      usable: (speaker: Speaker): Collection[] => knowledge.usable(who(speaker)),
      /** A document kept from this chat (`memory_write` about knowledge): saved, or waiting for an admin's yes. */
      keep: (speaker: Speaker, request: Omit<KeepRequest, "from"> & { name?: string; where: string }): Promise<KeepResult> => {
        // Who, as People knows them: in a one-to-one chat a platform's display name is not given to a turn (it is not
        // verified), and the admin asked to approve read "Someone".
        const { name, where, ...rest } = request;
        const chat = { agentId: speaker.agentId, gatewayId: speaker.gatewayId, chatId: speaker.chatId, chatType: speaker.chatType };
        return knowledge.keep(who(speaker), { ...rest, chat, from: `${situate(speaker).person?.name ?? name ?? "Someone"}, ${where}` });
      },
    },

    /** Stubs of tags no two episodes share, removed where nobody wrote in them. How many went. */
    async pruneStubs(): Promise<number> {
      return await pruneTagStubs(vault, analytics.tagCounts().counts);
    },

    // ─── search by meaning ───

    /** `room`, awaited before each batch — `catchUp`. A catch-up already running is joined as it is. */
    embedCatchUp,

    /**
     * Where search by meaning stands. `ranking` is there while another model's vectors rank searches — the model before
     * a change, until the one in use has as many (M7) — and names it and how many it has.
     */
    semanticStatus(): { enabled: boolean; model: string | null; items: number; running: boolean; reachable: boolean | null; ranking?: { model: string; items: number } } {
      const semantic = embedder();
      if (!semantic || !deps.vectors) return { enabled: false, model: null, items: 0, running: false, reachable: null };
      const ranking = rankingModel(deps.vectors, semantic.model);
      const before = ranking !== semantic.model && embedderFor(ranking) ? { ranking: { model: ranking, items: deps.vectors.count(ranking) } } : {};
      return { enabled: true, model: semantic.model, items: deps.vectors.count(semantic.model), running: catchingUp !== null, reachable: lastEmbed?.ok ?? null, ...before };
    },

    /** Let go of the vectors no search has read for a while — `memory-vectors.store.ts`; the pass's minute look asks. */
    releaseVectors(): void {
      deps.vectors?.release();
    },

    /** What the transcript archive holds — the dashboard shows it beside the archive switch. */
    archiveSize(): { files: number; bytes: number } {
      return archiveSize(vault);
    },

    /** FTS5's check of the keyword index — `nouride doctor` reports it; `reindex` rebuilds a damaged one. */
    indexCheck(): { ok: boolean; detail: string } {
      return deps.index.checkText();
    },

    // ─── the operator ───

    ...management,
    /** The dashboard's graph (`graph-view.ts`), with the knowledge base's layer over it when it is asked for (0.8.20). */
    graph(filter: GraphFilter, limit: number, options: { knowledge?: boolean } = {}): MemoryGraph {
      const graph = management.graph(filter, limit);
      const layer = options.knowledge ? knowledge.surface.layer(limit, config.people) : null;
      if (!layer) return graph;
      const shown = graph.nodes.filter((node) => node.kind === "episode").map((node) => node.id.slice("e:".length));
      return withKnowledge(graph, layer, deps.index.documentsOpened(shown));
    },
    // The word index is cleared whole and rebuilt from the vault; the documents are not in it, so their words go back after.
    reindex: () =>
      exclusive("a reindex", async () => {
        const report = await management.reindex();
        deps.knowledge?.store.rewriteWords();
        return report;
      }),
    forget: (...args: Parameters<typeof management.forget>) => exclusive("forgetting someone", () => management.forget(...args)),
  };
}

export type Memory = ReturnType<typeof createMemory>;
