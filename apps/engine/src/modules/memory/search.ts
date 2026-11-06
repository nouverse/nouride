/**
 * `memory_search` — what this audience may see, ranked — `docs/SPEC.md` §12.3.
 *
 * 1. **Access first.** Episodes are ranked already scoped to the audience (`scopeOf`, in the same SQL
 *    as the ranking), and facts pass `canSeeFact`. Nothing is ranked that could not be shown.
 * 2. **Keyword**: FTS5's BM25 over the word index (`memory-fts.store.ts`), the query built by `ftsQuery`.
 * 3. **Meaning**, when `[memory.semantic]` is on: cosine over the same visible items, by id — the ids this audience may
 *    see are asked of SQLite, their vectors are held in memory (`memory-vectors.store.ts`), and nothing is read whole
 *    until the end (M5).
 * 4. The two orderings fused (RRF), then scored: relevance 0.5, importance 0.3, recency 0.2 — over the episodes either
 *    ranking put near its top, the only ones read whole.
 * 5. Two hops over `related`, either way round — what a hit continues and what continued it — at 0.7
 *    of the score per hop, at most five per hit, nearest first.
 * 6. The pieces of one conversation as one hit (`collapsePieces`), so a long one split into parts does
 *    not fill the results with itself.
 *
 * A query with no words (only a date range or a person) returns episodes by those filters, newest
 * first — there is nothing to rank by.
 */

import type { Person } from "@nouride/shared";
import { canSeeFact, scopeOf, type Audience } from "./access.ts";
import { localTime } from "@/commons/clock.ts";
import { isOver } from "./fact-dates.ts";
import type { EpisodeFilter } from "./episode-filter.ts";
import type { IndexedEpisode, IndexedFact, MemoryIndexPort } from "./memory-index.store.ts";
import { EMBEDDED_STATUSES, fuse, meanVector, meaningOf, rankAgainst, type Meaning, type Semantic } from "./semantic.ts";
import { ftsQuery, queryTerms } from "./terms.ts";
import { SHARED } from "./vault.ts";
import type { IndexedSection, KnowledgePort } from "./knowledge/knowledge.store.ts";

const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 30;
/**
 * Visible episodes considered by meaning, newest first — every one a household has, in practice. Ids only: what each
 * costs is a lookup and a cosine, so the bound is the arithmetic on the event loop, not a read.
 */
const SEMANTIC_CANDIDATES = 5_000;
const WEIGHTS = { relevance: 0.5, importance: 0.3, recency: 0.2 };
/** Recency halves about every six weeks. */
const RECENCY_DAYS = 60;
/** Keyword hits fused with meaning: the best few hundred of a household's thousands. */
const KEYWORD_CANDIDATES = 200;
/** How far the hop walks `related`, what each link costs, and how many one hit may bring. */
const RELATED_DEPTH = 2;
const RELATED_DECAY = 0.7;
const RELATED_PER_HIT = 5;
/** What a document about someone named in the conversation is worth on top of its score (KNOWLEDGE_BASE §10). */
const ABOUT_BONUS = 0.1;
/**
 * Sections scored whole by meaning, at most: past it, documents are ranked by their sections' mean first and only the
 * sections of the nearest are scored (KNOWLEDGE_BASE §8). Measured on 2026-11-05: with 50,000 episodes, 10,000 sections
 * cost 17 ms a search warm and 50,000 cost 42, past memory's own bar; ranked by document first, 50,000 cost as 10,000.
 */
const SECTIONS_SCORED_WHOLE = 10_000;
/** Documents whose sections are scored, when there are more sections than that. */
const NEAREST_DOCUMENTS = 50;
/** A section's item id: never an episode to read whole, nor a fact. */
const isSection = (item: string) => item.startsWith("knowledge:");

export interface SearchRequest {
  audience: Audience;
  query: string;
  since?: string;
  until?: string;
  /** Person keys: conversations with or about them, and their facts. */
  people?: readonly string[];
  /** Only these agents' conversations — an MCP token's bound. */
  agents?: readonly string[];
  limit?: number;
  /** The knowledge collections this conversation may search, decided by the caller (`mayUse`), and whom each is about. */
  knowledge?: readonly KnowledgeScope[];
}

export interface KnowledgeScope {
  id: string;
  name: string;
  about: readonly string[];
}

export type SearchHit =
  | {
      kind: "episode";
      episode: IndexedEpisode;
      score: number;
      via?: string;
      /** The other pieces of the same conversation that were found too, oldest first — one hit stands for them all. */
      parts?: string[];
    }
  | { kind: "fact"; fact: IndexedFact; score: number }
  /** A section of a knowledge document (0.8.20), with its collection's name. */
  | { kind: "section"; section: IndexedSection; collection: string; about: string[]; score: number };

export interface SearchDeps {
  index: MemoryIndexPort;
  people: readonly Person[];
  semantic?: Semantic;
  /** The knowledge index (0.8.20): sections by id. */
  knowledge?: Pick<KnowledgePort, "itemsOf" | "sections" | "revision">;
  now: () => number;
  /** Whose calendar decides that a fact's `(until …)` day has passed. */
  timeZone: string;
}

/** Whose facts a search reads: the people in the chat, the people asked about, and anyone the query names. */
function subjectsFor(request: SearchRequest, people: readonly Person[], terms: readonly string[]): string[] {
  const subjects = new Set<string>(request.audience.kind === "dm" ? [request.audience.person] : request.audience.present);
  for (const key of request.people ?? []) subjects.add(key);
  for (const person of people) {
    if (!person.key) continue;
    const names = [person.key, ...person.name.toLowerCase().split(/\s+/)];
    if (names.some((name) => terms.includes(name))) subjects.add(person.key);
  }
  return [...subjects].filter((subject) => !subject.includes(":"));
}

function recency(startedAt: number, now: number): number {
  return Math.exp((-(now - startedAt) / 86_400_000) * (Math.LN2 / RECENCY_DAYS));
}

export async function searchMemory(deps: SearchDeps, request: SearchRequest): Promise<SearchHit[]> {
  const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(request.limit ?? LIMIT_DEFAULT)));
  const terms = queryTerms(request.query);
  const match = ftsQuery(request.query);
  const filter: EpisodeFilter = {
    scope: scopeOf(request.audience),
    ...(request.agents?.length ? { agents: request.agents } : {}),
    ...(request.since ? { since: request.since } : {}),
    ...(request.until ? { until: request.until } : {}),
    ...(request.people?.length ? { people: request.people } : {}),
  };

  if (!match) {
    return deps.index.episodes(filter, limit).map((episode) => ({ kind: "episode", episode, score: 0 }));
  }

  // Facts have no dates and no agents: a search narrowed by either is a search of conversations. So do documents.
  const readsFacts = !request.since && !request.until && !request.agents?.length;
  const subjects = subjectsFor(request, deps.people, terms);
  const facts = readsFacts
    ? deps.index
        .facts([...subjects, SHARED])
        .filter((fact) => fact.subject === SHARED || canSeeFact(fact, fact.subject, request.audience))
        // Over is not found either: the conversation it came from still is, by its summary.
        .filter((fact) => !isOver(fact.text, localTime(deps.now(), deps.timeZone).day))
    : [];
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  // The collections it may search, and with people named, only those about one of them.
  const scopes = readsFacts && deps.knowledge ? (request.knowledge ?? []).filter((scope) => !request.people?.length || scope.about.some((key) => request.people!.includes(key))) : [];
  const collections = scopes.map((scope) => scope.id);

  // Ranked inside SQLite, already scoped: episodes this audience may see, the facts it may read, the sections of the
  // collections it may search.
  const byWords = deps.index.rank(match, filter, [...factsById.keys()], KEYWORD_CANDIDATES, collections);

  let byMeaning: string[] = [];
  if (deps.semantic) {
    // The episodes this audience may see that can have a vector — by id, scoped in the same SQL as the words.
    const candidates = deps.index.episodeIds({ ...filter, statuses: EMBEDDED_STATUSES }, SEMANTIC_CANDIDATES);
    // Keyword hits are candidates whatever their age: the cap is the newest few thousand, and the words found these.
    const visible = new Set([...candidates, ...byWords.filter((item) => !item.startsWith("fact:") && !isSection(item))]);
    const meaning = await meaningOf(deps.semantic, request.query);
    if (meaning) {
      // Every section of those collections: a document does not age, so none is left out for being old (§8).
      let sections = collections.length && deps.knowledge ? deps.knowledge.itemsOf(collections) : [];
      if (sections.length > SECTIONS_SCORED_WHOLE && deps.knowledge) sections = nearestDocumentsSections(meaning, sections, deps.knowledge.revision());
      byMeaning = rankAgainst(meaning, [...visible, ...factsById.keys(), ...sections], limit * 3).map((hit) => hit.item);
    }
  }

  // Read whole only what can be a hit: what the words found, and the top of what meaning found.
  const found = [...new Set([...byWords, ...byMeaning])];
  const wanted = found.filter((item) => !item.startsWith("fact:") && !isSection(item));
  const visibleEpisodes = new Map(deps.index.episodes({ ...filter, ids: wanted }, wanted.length).map((episode) => [episode.id, episode]));
  const sectionsFound = new Map((deps.knowledge?.sections(found.filter(isSection)) ?? []).map((section) => [section.item, section]));
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));

  // With one ranking there is nothing to protect from: the bonus would only rescale it.
  const fused = byMeaning.length ? fuse([byWords, byMeaning], { exact: byWords }) : fuse([byWords]);
  const top = Math.max(...fused.values(), 0) || 1;
  const now = deps.now();
  const hits = new Map<string, SearchHit>();
  for (const [item, rrf] of fused) {
    const relevance = rrf / top;
    const episode = visibleEpisodes.get(item);
    if (episode) {
      const score = WEIGHTS.relevance * relevance + WEIGHTS.importance * ((episode.importance ?? 3) / 5) + WEIGHTS.recency * recency(episode.startedAt, now);
      hits.set(item, { kind: "episode", episode, score });
    } else if (isSection(item)) {
      const section = sectionsFound.get(item);
      const scope = section ? scopeById.get(section.collection) : undefined;
      // A document is what is known now, as a fact is; one about someone this conversation is about counts more (§10).
      if (section && scope) {
        const about = scope.about.some((key) => subjects.includes(key)) ? ABOUT_BONUS : 0;
        // Whom it is about, by name, for the line the model reads: without it the one found first could not be told apart
        // from its twin (0.8.20's check on the box).
        const named = scope.about.map((key) => deps.people.find((person) => person.key === key)?.name ?? key);
        hits.set(item, { kind: "section", section, collection: scope.name, about: named, score: WEIGHTS.relevance * relevance + WEIGHTS.importance * 0.6 + WEIGHTS.recency + about });
      }
    } else {
      const fact = factsById.get(item);
      // A fact is what is known now: full recency, middling importance.
      if (fact) hits.set(item, { kind: "fact", fact, score: WEIGHTS.relevance * relevance + WEIGHTS.importance * 0.6 + WEIGHTS.recency });
    }
  }

  const ranked = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  hop(deps, filter, ranked, hits);
  return collapsePieces([...hits.values()]).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Each document's mean vector, by model, for the knowledge index as it stood (`KnowledgePort.revision`) and the vectors held. */
const documentMeans = new Map<string, { version: string; means: Map<string, { mean: Int8Array; items: string[] }> }>();

/** The document a section belongs to: its item up to its number. */
const documentOf = (item: string) => item.slice(0, item.lastIndexOf("#"));

/**
 * The sections of the documents nearest the query by their sections' mean (`NEAREST_DOCUMENTS`): a search over more
 * sections than `SECTIONS_SCORED_WHOLE` scores those rather than every one. The means are worked out once for the index
 * and the model as they are, and again after either changes.
 */
function nearestDocumentsSections(meaning: Meaning, sections: readonly string[], indexVersion: string): string[] {
  const version = `${indexVersion}:${meaning.vectors.size}`;
  let held = documentMeans.get(meaning.model);
  if (!held || held.version !== version) {
    const grouped = new Map<string, string[]>();
    for (const item of sections) grouped.set(documentOf(item), [...(grouped.get(documentOf(item)) ?? []), item]);
    const means = new Map<string, { mean: Int8Array; items: string[] }>();
    for (const [document, items] of grouped) {
      const mean = meanVector(items.flatMap((item) => meaning.vectors.get(item) ?? []));
      if (mean) means.set(document, { mean, items });
    }
    held = { version, means };
    documentMeans.set(meaning.model, held);
  }
  const wanted = new Set(sections.map(documentOf));
  const ranked = [...held.means].filter(([document]) => wanted.has(document)).map(([document, { mean }]) => ({ document, score: meaning.score(mean) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, NEAREST_DOCUMENTS).flatMap(({ document }) => held!.means.get(document)!.items);
}

/**
 * Two pieces of one cut: the same chat, each linking the other.
 *
 * A cut splits a stretch at each local day and at what one nightly call reads, and links each piece to the
 * pieces either side of it, both ways (`cut.ts`, `episodesOf`). Nothing else writes a link both ways: the pass
 * links an episode to older ones it shares people and tags with, from the newer side only.
 */
function piecesOfOneCut(a: IndexedEpisode, b: IndexedEpisode): boolean {
  return a.chat === b.chat && a.related.includes(b.id) && b.related.includes(a.id);
}

/**
 * The pieces of one conversation found together, as one hit (M12): the best-scoring piece, with the others' ids.
 *
 * A long conversation is several pieces, each summarised alone, and a query about it finds one and the hop brings
 * the rest — so ten results could be three conversations, one of them four times. Grouped transitively, since a
 * day's conversation can be pieces one, two and three; the one kept is the best match and says where the others
 * are, so nothing found is lost — `memory_read` opens each by its id.
 */
function collapsePieces(hits: readonly SearchHit[]): SearchHit[] {
  const episodes = hits.flatMap((hit) => (hit.kind === "episode" ? [hit] : []));
  const byId = new Map(episodes.map((hit) => [hit.episode.id, hit]));
  const root = new Map(episodes.map((hit) => [hit.episode.id, hit.episode.id]));
  const find = (id: string): string => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at)!;
    return at;
  };
  for (const hit of episodes) {
    for (const id of hit.episode.related) {
      const other = byId.get(id);
      if (other && piecesOfOneCut(hit.episode, other.episode)) root.set(find(id), find(hit.episode.id));
    }
  }
  const groups = new Map<string, (typeof episodes)[number][]>();
  for (const hit of episodes) groups.set(find(hit.episode.id), [...(groups.get(find(hit.episode.id)) ?? []), hit]);

  const kept: SearchHit[] = hits.filter((hit) => hit.kind !== "episode");
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => (b.score > a.score ? b : a));
    const parts = group.filter((hit) => hit !== best).sort((a, b) => a.episode.startedAt - b.episode.startedAt).map((hit) => hit.episode.id);
    kept.push(parts.length ? { ...best, parts } : best);
  }
  return kept;
}

/**
 * The conversations a hit continues and the ones that continued it, two links out either way, if this
 * audience may see them: each at 0.7 of its origin's score per link, at most five per hit, nearest
 * first and then newest, best origin first. Into `hits`, never over a hit already there.
 */
function hop(deps: SearchDeps, filter: EpisodeFilter, ranked: readonly SearchHit[], hits: Map<string, SearchHit>): void {
  const origins = ranked.flatMap((hit) => (hit.kind === "episode" ? [hit] : []));
  const walked = deps.index.reachable(origins.map((hit) => hit.episode.id), RELATED_DEPTH).filter((step) => !hits.has(step.id));
  if (walked.length === 0) return;
  const ids = [...new Set(walked.map((step) => step.id))];
  const reachable = new Map(deps.index.episodes({ ...filter, ids }, ids.length).map((episode) => [episode.id, episode]));
  for (const origin of origins) {
    const near = walked
      .filter((step) => step.origin === origin.episode.id && reachable.has(step.id))
      .sort((a, b) => a.depth - b.depth || reachable.get(b.id)!.startedAt - reachable.get(a.id)!.startedAt);
    let brought = 0;
    for (const step of near) {
      if (brought === RELATED_PER_HIT) break;
      if (hits.has(step.id)) continue;
      const episode = reachable.get(step.id)!;
      hits.set(step.id, { kind: "episode", episode, score: origin.score * RELATED_DECAY ** step.depth, via: origin.episode.id });
      // A piece of the origin's own conversation is folded into the origin's hit (`collapsePieces`): it leaves the
      // five for conversations the origin led to.
      if (!piecesOfOneCut(origin.episode, episode)) brought += 1;
    }
  }
}
