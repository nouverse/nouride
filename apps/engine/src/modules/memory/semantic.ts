/**
 * Search by meaning — the vectors half of `memory_search` (`docs/SPEC.md` §12.3).
 *
 * What is embedded: every filed episode's summary and tags, and every fact. Not raw transcripts: they
 * are long, short-lived, and the keyword index already reaches them until they are filed.
 *
 * This file knows nothing about providers. Boot hands it `embed(texts)`, which resolves
 * `[memory.semantic]` on every call, so a setting changed on the dashboard is used by the next
 * search. A call that fails returns null and the caller searches by words alone — meaning makes
 * search better; it is never a reason for search to fail.
 *
 * Access is not decided here either: `rankByMeaning` is handed items the audience may already see.
 *
 * **A change of model.** Each model's vectors are kept under its own key, side by side, and the new one is caught
 * up 2,000 items a night. Until it has as many vectors as the model before it, a search is ranked by the one before —
 * its query embedded by that model, through the provider its key names — and once the new one has every item, the old
 * one's vectors go (`catchUp`). A key whose provider cannot be asked any more ranks nothing: the model in use ranks with
 * what it has, as it always did. Items filed since the change have only the new model's vectors, so while the old one
 * ranks they are found by their words alone — for the nights a catch-up takes, or until `Embed now` finishes it.
 */

import type { MemorySemanticSection } from "@nouride/shared";
import type { EpisodeStatus } from "./episode.ts";
import { textHash } from "./index-sync.ts";
import type { IndexedEpisode, IndexedFact, MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryVectorPort } from "./memory-vectors.store.ts";

/**
 * Texts per request. Eight: a local model on a CPU (Ollama, `bge-m3`) timed out on 32 summary-length
 * texts, and a failed batch stops the whole run.
 */
const BATCH = 8;
/** Texts embedded per catch-up, so turning this on over a large archive spreads across nights. */
const PER_CATCH_UP = 2_000;

/** The episodes that are given a vector: filed ones, which have a summary to embed. A raw one never has one. */
export const EMBEDDED_STATUSES: readonly EpisodeStatus[] = ["summarized", "compacted"];

export interface Embedder {
  /** The key vectors are recorded under — `vectorKey`; a change re-embeds everything. */
  model: string;
  /** Vectors in input order, or null when the call failed. */
  embed(texts: string[]): Promise<number[][] | null>;
}

/** What searching by meaning is handed: the vectors, the model in use, and a way to ask the model another key names. */
export interface Semantic {
  vectors: MemoryVectorPort;
  embedder: Embedder;
  /**
   * The model a vector key names, to embed a query for its vectors: the one before a change of model, while the one in
   * use catches up. Null when it cannot be asked — a key with no size in it, or a provider that has just failed.
   */
  embedderFor?: (key: string) => Embedder | null;
}

type VectorSettings = Pick<MemorySemanticSection, "provider" | "model" | "dimensions">;

/**
 * What a vector is recorded under: the provider, the model and the size asked of it. The size was not part of it,
 * so a change of `dimensions` kept every vector at the old size — a query at the new one compares with none of them,
 * and since no item's text had changed, nothing was embedded again: search by meaning ranked nothing, unannounced.
 */
export function vectorKey(semantic: VectorSettings): string {
  return `${semantic.provider}/${semantic.model}@${semantic.dimensions}`;
}

/**
 * What a vector key names — `vectorKey` read back — or null for one that names no size, whose vectors could be of
 * several sizes, so no one query could be compared with them all. No build since 0.7.2 writes one, and 0.7.22 sized
 * every one there was. The provider runs to the first `/` (a profile's name has
 * none) and the size follows the last `@`, so a model named `@cf/baai/bge-base-en-v1.5` is whole.
 */
export function parseVectorKey(key: string): VectorSettings | null {
  const slash = key.indexOf("/");
  const at = key.lastIndexOf("@");
  if (slash <= 0 || at <= slash + 1) return null;
  const dimensions = Number(key.slice(at + 1));
  if (!Number.isInteger(dimensions) || dimensions <= 0) return null;
  return { provider: key.slice(0, slash), model: key.slice(slash + 1, at), dimensions };
}

/** The unit vector, scaled to int8. Cosine between two of these is barely moved by the rounding. */
function quantize(vector: readonly number[]): Int8Array {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Int8Array.from(vector, (x) => Math.max(-127, Math.min(127, Math.round((x / norm) * 127))));
}

/**
 * Cosine against `target`, its length worked out once rather than once per candidate — a third of the arithmetic a
 * search by meaning does. The sums are integers, so every score is exactly what the per-pair form gave; a vector of
 * another size scores 0.
 */
function cosineTo(target: Int8Array): (vector: Int8Array) => number {
  let nt = 0;
  for (let i = 0; i < target.length; i += 1) nt += target[i]! * target[i]!;
  return (vector) => {
    if (vector.length !== target.length) return 0;
    let dot = 0;
    for (let i = 0; i < vector.length; i += 1) dot += target[i]! * vector[i]!;
    const nv = normOf(vector);
    return nt && nv ? dot / Math.sqrt(nt * nv) : 0;
  };
}

/**
 * Each held vector's squared length, worked out once: a search by meaning over the knowledge base's tens of thousands of
 * sections (0.8.20) spent half its arithmetic on lengths that never change. Keyed by the vector itself, the view the
 * store holds, so a vector made again is a new key and its old length goes with it.
 */
const norms = new WeakMap<Int8Array, number>();
function normOf(vector: Int8Array): number {
  let n = norms.get(vector);
  if (n === undefined) {
    n = 0;
    for (let i = 0; i < vector.length; i += 1) n += vector[i]! * vector[i]!;
    norms.set(vector, n);
  }
  return n;
}

/** Cosine between two stored vectors — 0 when their sizes differ. */
export function similarity(a: Int8Array, b: Int8Array): number {
  return cosineTo(a)(b);
}

/**
 * What several stored vectors mean together: their mean, stored as one is (0.8.20, a knowledge document's sections).
 * Each is a unit vector scaled to int8, so their sum points where their mean does, and is scaled
 * back as one vector. Vectors of another size than the first are left out; null for none.
 */
export function centroid(vectors: readonly Int8Array[]): Int8Array | null {
  const size = vectors[0]?.length ?? 0;
  const sum = new Array<number>(size).fill(0);
  let counted = 0;
  for (const vector of vectors) {
    if (vector.length !== size) continue;
    for (let i = 0; i < size; i += 1) sum[i] = sum[i]! + vector[i]!;
    counted += 1;
  }
  return size && counted ? quantize(sum) : null;
}

function episodeText(episode: Pick<IndexedEpisode, "summary" | "tags">): string {
  return episode.tags.length ? `${episode.summary ?? ""} (${episode.tags.join(", ")})` : (episode.summary ?? "");
}

function factText(fact: Pick<IndexedFact, "section" | "text">): string {
  return `${fact.section}: ${fact.text}`;
}

export interface CatchUpReport {
  embedded: number;
  /** Vectors of items that are gone, whichever model made them. */
  pruned: number;
  /** Vectors another model made, removed because this one now has every item. */
  superseded: number;
  /** Still without a vector after this run's cap — the next run continues. */
  waiting: number;
  /** The provider failed; nothing more was tried this run. */
  failed: boolean;
}

/**
 * Give every filed episode and fact without a vector for its current text one, and drop the vectors of what is gone.
 * `room`, awaited before each batch, is the scheduled night's wait while the box is busy (0.8.0): against a model on the
 * same machine, a catch-up of hundreds of texts is minutes of its CPU.
 */
export async function catchUp(deps: {
  index: MemoryIndexPort;
  vectors: MemoryVectorPort;
  embedder: Embedder;
  now: () => number;
  room?: () => Promise<unknown>;
  /** Knowledge sections, by id and the words their vector is made from (0.8.20): kept, embedded and pruned with the rest. */
  sections?: () => readonly { item: string; text: string }[];
}): Promise<CatchUpReport> {
  const { model } = deps.embedder;
  const wanted: { item: string; text: string; hash: string }[] = [];
  const want = (item: string, text: string) => wanted.push({ item, text, hash: textHash(text) });
  for (const page of deps.index.pages({ statuses: EMBEDDED_STATUSES })) {
    for (const episode of page) if (episode.summary) want(episode.id, episodeText(episode));
  }
  for (const fact of deps.index.facts(deps.index.subjects())) want(fact.id, factText(fact));
  for (const section of deps.sections?.() ?? []) want(section.item, section.text);

  /**
   * What is gone goes now, whichever model made it: a forgotten conversation is not to be found by meaning. Another
   * model's vectors are not deleted ahead of this one's. They were pruned first, so a model that could not be
   * reached, or one tried and switched back from, left nothing: every vector of the old model gone before a single new
   * one existed. Now they are kept beside this model's — the key is the item and the model — and rank searches until
   * this one has every item (`rankingModel`); then they go, below.
   */
  const pruned = deps.vectors.pruneGone(new Set(wanted.map((row) => row.item)));
  const have = deps.vectors.hashes(model);
  const missing = wanted.filter((row) => have.get(row.item) !== row.hash);
  const todo = missing.slice(0, PER_CATCH_UP);

  let embedded = 0;
  for (let start = 0; start < todo.length; start += BATCH) {
    await deps.room?.();
    const batch = todo.slice(start, start + BATCH);
    const vectors = await deps.embedder.embed(batch.map((row) => row.text));
    if (!vectors || vectors.length !== batch.length) return { embedded, pruned, superseded: 0, waiting: missing.length - embedded, failed: true };
    deps.vectors.put(batch.map((row, i) => ({ item: row.item, vector: quantize(vectors[i]!), hash: row.hash })), model, deps.now());
    embedded += batch.length;
  }
  const waiting = missing.length - embedded;
  // Every item has this model's vector for its text now, so no search is ranked by another model's again.
  const superseded = waiting === 0 ? deps.vectors.keepOnly(model) : 0;
  return { embedded, pruned, superseded, waiting, failed: false };
}

/**
 * The model whose vectors rank a search: the one with the most of them, the model in use on a tie. While a change of
 * model is caught up, the one before has every item and the new one some, so the one before ranks; once the new one has
 * as many it does, and the catch-up that got it there removed the others. From counts the store holds (`counts`).
 */
export function rankingModel(vectors: Pick<MemoryVectorPort, "counts">, current: string): string {
  const counts = vectors.counts();
  let best = current;
  let most = counts.get(current) ?? 0;
  for (const [model, n] of counts) {
    if (n > most) {
      best = model;
      most = n;
    }
  }
  return best;
}

/** The vectors a search ranks by (`rankingModel`) — while a change of model is caught up, the one before. */
export function rankingVectors(semantic: Semantic): ReadonlyMap<string, Int8Array> {
  return semantic.vectors.of(rankingModel(semantic.vectors, semantic.embedder.model));
}

/**
 * Items ordered by meaning, most similar first, or null when the query could not be embedded. An
 * item with no vector yet is left out rather than guessed at; the keyword half still has it.
 *
 * Scored against the vectors the store holds in memory: a search reads no vector from the database and decodes
 * none. Ranked by `rankingModel`, its query embedded by that model — and when that is not the model in use and cannot
 * be asked, or fails, by the model in use over the vectors it has.
 */
export async function rankByMeaning(semantic: Semantic, query: string, items: readonly string[], top = Infinity): Promise<{ item: string; score: number }[] | null> {
  if (items.length === 0) return [];
  const meaning = await meaningOf(semantic, query);
  return meaning ? rankAgainst(meaning, items, top) : null;
}

/** A query by meaning: the model whose vectors it is scored against, those vectors, and the score of one of them. */
export interface Meaning {
  model: string;
  vectors: ReadonlyMap<string, Int8Array>;
  score: (vector: Int8Array) => number;
}

/**
 * The query embedded by the model that ranks (`rankingModel`), or by the model in use when that one cannot be asked or
 * fails; null when neither embeds it. Once per search, for every ranking it does.
 */
export async function meaningOf(semantic: Semantic, query: string): Promise<Meaning | null> {
  const ranking = rankingModel(semantic.vectors, semantic.embedder.model);
  const before = ranking === semantic.embedder.model ? null : (semantic.embedderFor?.(ranking) ?? null);
  for (const embedder of before ? [before, semantic.embedder] : [semantic.embedder]) {
    const embedded = await embedder.embed([query]);
    if (embedded?.[0]) return { model: embedder.model, vectors: semantic.vectors.of(embedder.model), score: cosineTo(quantize(embedded[0])) };
  }
  return null;
}

/** Items most similar first, at most `top`; an item with no vector left out. */
export function rankAgainst(meaning: Meaning, items: readonly string[], top = Infinity): { item: string; score: number }[] {
  {
    const { score, vectors } = meaning;
    const ranked: { item: string; score: number }[] = [];
    // With `top`, the best so far only, kept in order: tens of thousands scored, a few dozen kept, nothing sorted whole.
    let floor = -Infinity;
    for (const item of items) {
      const vector = vectors.get(item);
      if (!vector) continue;
      const scored = score(vector);
      if (ranked.length >= top && scored <= floor) continue;
      ranked.push({ item, score: scored });
      if (ranked.length > top * 4) {
        ranked.sort((a, b) => b.score - a.score).length = top;
        floor = ranked[top - 1]!.score;
      }
    }
    const sorted = ranked.sort((a, b) => b.score - a.score);
    return Number.isFinite(top) ? sorted.slice(0, top) : sorted;
  }
}

/**
 * The mean of vectors, as a vector of its own (quantized like every stored one): a knowledge document's, from its
 * sections, which a search over tens of thousands of sections ranks first (`search.ts`) and Related documents compares.
 */
export function meanVector(vectors: readonly Int8Array[]): Int8Array | null {
  const first = vectors[0];
  if (!first) return null;
  const sum = new Float64Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== first.length) continue;
    for (let i = 0; i < vector.length; i += 1) sum[i]! += vector[i]!;
  }
  return quantize(Array.from(sum));
}

/**
 * What the keyword ranking's first three places are worth on top of their share, in shares of a first place
 * (`1 / (k + 1)`) — QMD's top-rank bonus, in the units it is added to.
 *
 * As absolute numbers (0.05, 0.02, 0.02) against a first place's 1/61 ≈ 0.016, the bonus was three
 * rankings' worth: a keyword-only hit at second place outranked an item both rankings put near the top.
 * Sized here so two things hold, and `tests/memory/fusion.test.ts` holds them: an exact hit in the
 * keyword top three outranks an item only meaning found, its first included; and an item both rankings
 * place in their top three outranks an item one of them found alone, bonus and all.
 */
const EXACT_BONUS = [0.5, 0.25, 0.25];

/**
 * Reciprocal rank fusion: where two orderings agree an item rises; one only one of them knows still
 * counts. The exact ranking's first three places keep a bonus, so a keyword hit — an IP, a port, a
 * config key the query names exactly — is not pushed down by fuzzier neighbours by meaning.
 */
export function fuse(rankings: readonly (readonly string[])[], options: { exact?: readonly string[]; k?: number } = {}): Map<string, number> {
  const k = options.k ?? 60;
  const score = new Map<string, number>();
  for (const ranking of rankings) ranking.forEach((item, rank) => score.set(item, (score.get(item) ?? 0) + 1 / (k + rank + 1)));
  options.exact?.slice(0, EXACT_BONUS.length).forEach((item, rank) => score.set(item, (score.get(item) ?? 0) + EXACT_BONUS[rank]! / (k + 1)));
  return score;
}
