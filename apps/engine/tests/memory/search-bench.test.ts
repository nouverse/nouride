/**
 * `memory_search` with meaning at 1k, 10k and 50k items — by hand, skipped otherwise:
 *
 *   NOURIDE_BENCH_SEARCH=1 bun test apps/engine/tests/memory/search-bench.test.ts
 *
 * A synthetic vault in a temp directory, put straight into the index (search reads the index, never the files): one
 * episode an hour for as many hours as asked, every one in a chat the searcher was in so their DM sees them all, 512-dim
 * vectors, about 1% of summaries holding the word searched for. One search cold (the first, which reads the vectors
 * into memory), then twenty warm: the time, and the episodes read whole. Run it before and after a change to search,
 * the vector store or a memory migration, on the same machine, and quote both. What the vectors held in memory cost is
 * not measured here: that needs a collection forced on both sides of the read, which `bun test` cannot do.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MemoryIndexStore, type IndexedEpisode } from "@/modules/memory/memory-index.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { KnowledgeStore } from "@/modules/memory/knowledge/knowledge.store.ts";
import { searchMemory } from "@/modules/memory/search.ts";
import { ftsDoc } from "@/modules/memory/terms.ts";
import { tempDir } from "../helpers.ts";

const DIMS = 512;
const SIZES = [1_000, 10_000, 50_000];
const WARM = 20;
const MODEL = "bench/vec@512";
const START = Date.UTC(2023, 0, 1);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function unit(next: () => number): number[] {
  const v = Array.from({ length: DIMS }, () => next() * 2 - 1);
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

const quantize = (v: readonly number[]) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
const round = (n: number) => Math.round(n * 10) / 10;

/** `size` episodes in the index, and their words. */
function fill(index: MemoryIndexStore, db: { transaction<T>(fn: () => T): T }, size: number, next: () => number): void {
  const vocabulary = Array.from({ length: 2_000 }, (_, i) => `kata${i.toString(36)}`);
  const tags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
  db.transaction(() => {
    for (let i = 0; i < size; i += 1) {
      const startedAt = START + i * 3_600_000;
      const day = new Date(startedAt).toISOString().slice(0, 10);
      const words = Array.from({ length: 12 }, () => vocabulary[Math.floor(next() * vocabulary.length)]!);
      if (next() < 0.01) words.push("kebun");
      const summary = words.join(" ");
      const episodeTags = [...new Set([tags[Math.floor(next() * tags.length)]!, tags[Math.floor(next() * tags.length)]!])];
      const episode: IndexedEpisode = {
        id: `bench-${i}`, status: "summarized", kind: "dm", chat: `telegram:nouva:${i % 50}`, day, week: "2023-W01", month: day.slice(0, 7),
        startedAt, endedAt: startedAt + 600_000, importance: 3, summary, agents: ["nouva"], participants: ["gading"], mentions: [], tags: episodeTags,
        related: i % 10 === 0 && i > 0 ? [`bench-${i - 1}`] : [],
      };
      index.putEpisode(episode, ftsDoc({ summary, tags: episodeTags.join(" ") }), { path: `episodes/${episode.id}.md`, state: { mtimeMs: startedAt, size: 100 } });
    }
  });
}

/**
 * `count` knowledge sections (0.8.20), in documents of a hundred sections each of one collection every search may read:
 * the same words as the episodes, and a vector each. Every one of them is scored by meaning (no age cap for documents).
 */
function fillSections(store: KnowledgeStore, vectors: MemoryVectorStore, count: number, next: () => number): void {
  const vocabulary = Array.from({ length: 2_000 }, (_, i) => `kata${i.toString(36)}`);
  for (let doc = 0; doc * 100 < count; doc += 1) {
    const n = Math.min(100, count - doc * 100);
    const sections = Array.from({ length: n }, (_, i) => {
      const words = Array.from({ length: 60 }, () => vocabulary[Math.floor(next() * vocabulary.length)]!);
      if (next() < 0.01) words.push("kebun");
      return { n: i, trail: `Document ${doc} › Part ${i}`, text: words.join(" ") };
    });
    store.replace({ collection: "bench", path: `doc-${doc}.md`, size: 1, mtime: 1, title: `Document ${doc}`, status: "indexed", sections: n, indexedAt: 1 }, sections);
    vectors.put(sections.map((section) => ({ item: `knowledge:bench/doc-${doc}.md#${section.n}`, vector: quantize(unit(next)), hash: "h" })), MODEL, 1);
  }
}

async function search(size: number, sections = 0) {
  const dir = tempDir("search-bench");
  const db = await openAndMigrate(join(dir, "bench.db"));
  const index = new MemoryIndexStore(db);
  const vectors = new MemoryVectorStore(db);
  const knowledge = new KnowledgeStore(db);
  const next = random(size);
  fill(index, db, size, next);
  for (let i = 0; i < size; i += 2_000) {
    vectors.put(Array.from({ length: Math.min(2_000, size - i) }, (_, j) => ({ item: `bench-${i + j}`, vector: quantize(unit(next)), hash: "h" })), MODEL, 1);
  }
  if (sections) fillSections(knowledge, vectors, sections, next);

  let hydrated = 0;
  const counted = new Proxy(index, {
    get(target, key) {
      if (key === "episodes") {
        return (...args: Parameters<MemoryIndexStore["episodes"]>) => {
          const rows = target.episodes(...args);
          hydrated += rows.length;
          return rows;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const query = unit(random(7));
  const embedder = { model: MODEL, embed: async (texts: string[]) => texts.map(() => query) };
  const deps = { index: counted, people: [], semantic: { vectors, embedder }, now: () => START + size * 3_600_000, timeZone: "UTC", ...(sections ? { knowledge } : {}) };
  const request = {
    audience: { kind: "dm" as const, chat: "telegram:nouva:0", person: "gading" },
    query: "kebun",
    ...(sections ? { knowledge: [{ id: "bench", name: "Bench", about: [] }] } : {}),
  };

  const coldStart = performance.now();
  const first = await searchMemory(deps, request);
  const cold = performance.now() - coldStart;
  const coldHydrated = hydrated;
  const times: number[] = [];
  for (let i = 0; i < WARM; i += 1) {
    hydrated = 0;
    const t = performance.now();
    await searchMemory(deps, request);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  db.close();
  removePath(dir);
  return {
    size,
    sections,
    hits: first.length,
    coldMs: round(cold),
    warmMedianMs: round(times[Math.floor(WARM / 2)]!),
    warmP95Ms: round(times[Math.floor(WARM * 0.95)]!),
    hydratedCold: coldHydrated,
    hydratedWarm: hydrated,
  };
}

describe.skipIf(!process.env.NOURIDE_BENCH_SEARCH)("memory at scale", () => {
  test("memory_search with meaning at 1k, 10k, 50k items", async () => {
    const results = [];
    for (const size of SIZES) results.push(await search(size));
    console.table(results);
    expect(results.length).toBe(SIZES.length);
  }, 600_000);

  test("with the knowledge base: 50k episodes and 1k, 10k, 50k sections of documents (0.8.20)", async () => {
    const results = [];
    for (const sections of SIZES) results.push(await search(50_000, sections));
    console.table(results);
    expect(results.length).toBe(SIZES.length);
  }, 900_000);
});
