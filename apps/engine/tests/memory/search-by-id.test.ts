/**
 * Search by meaning over ids: the episodes an audience may see are asked of SQLite by id, scored against vectors
 * held in memory, and only what can be a hit is read whole. It read up to 5,000 episodes whole — five statements each —
 * and decoded every candidate's vector from base64, only to rank them.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MemoryIndexStore, type IndexedEpisode } from "@/modules/memory/memory-index.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { searchMemory, type SearchDeps } from "@/modules/memory/search.ts";
import { ftsDoc } from "@/modules/memory/terms.ts";
import { tempDir } from "../helpers.ts";

const MODEL = "fake/vec@4";
const HERE = "telegram:nouva:814";
const AUDIENCE = { kind: "dm" as const, chat: HERE, person: "gading" };

let dir: string;
let db: SqliteDb;
let index: MemoryIndexStore;
let vectors: MemoryVectorStore;
/** Episodes the search read whole, and vectors it read from the database. */
let hydrated: number;
let vectorReads: number;

beforeEach(async () => {
  dir = tempDir("search-by-id");
  db = await openAndMigrate(join(dir, "test.db"));
  index = new MemoryIndexStore(db);
  vectors = new MemoryVectorStore({
    ...db,
    prepare: (sql: string) => {
      if (/SELECT item, vector FROM memory_vectors/.test(sql)) vectorReads += 1;
      return db.prepare(sql);
    },
  } as SqliteDb);
  hydrated = 0;
  vectorReads = 0;
});

afterEach(() => {
  db.close();
  removePath(dir);
});

/** An episode in `chat`, with the searcher taking part only where it is their own chat — the others are not theirs to see. */
function episode(i: number, chat: string, summary: string, vector: number[]): void {
  const startedAt = Date.UTC(2026, 0, 1) + i * 60_000;
  const row: IndexedEpisode = {
    id: `2026-01-01-${String(i).padStart(4, "0")}-nouva`, status: "summarized", kind: "dm", chat, day: "2026-01-01", week: "2026-W01", month: "2026-01",
    startedAt, endedAt: startedAt + 1, importance: 3, summary, agents: ["nouva"], participants: chat === HERE ? ["gading"] : ["sam"], mentions: [], tags: [], related: [],
  };
  index.putEpisode(row, ftsDoc({ summary }), { path: `episodes/${row.id}.md`, state: { mtimeMs: startedAt, size: 1 } });
  vectors.put([{ item: row.id, vector: Int8Array.from(vector), hash: "h" }], MODEL, 1);
}

function deps(): SearchDeps {
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
  // "holiday" is on the first axis; nothing says the word, so only meaning can find anything.
  const embedder = { model: MODEL, embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
  return { index: counted, people: [], semantic: { vectors, embedder }, now: () => Date.UTC(2026, 6, 1), timeZone: "UTC" };
}

test("of 600 episodes ranked by meaning, only the top of the ranking is read whole — and no vector from the database twice", async () => {
  db.transaction(() => {
    for (let i = 0; i < 600; i += 1) episode(i, HERE, `Percakapan ${i}`, i === 123 ? [127, 0, 0, 0] : [0, 127, (i % 7) - 3, 0]);
  });

  const hits = await searchMemory(deps(), { audience: AUDIENCE, query: "holiday", limit: 10 });
  expect(hits[0]).toMatchObject({ kind: "episode", episode: { id: "2026-01-01-0123-nouva" } });
  // Three times the limit by meaning, and no keyword hit: thirty read whole, where every one of the 600 was.
  expect(hydrated).toBe(30);

  for (let i = 0; i < 3; i += 1) await searchMemory(deps(), { audience: AUDIENCE, query: "holiday", limit: 10 });
  expect(vectorReads).toBe(1);
});

test("an episode this audience may not see is never ranked, so it never pushes one it may see out of the top", async () => {
  db.transaction(() => {
    // Forty in someone else's chat, each exactly what was asked; one here, near it.
    for (let i = 0; i < 40; i += 1) episode(i, "telegram:nix:777", `Liburan ${i}`, [127, 0, 0, 0]);
    episode(40, HERE, "Rencana", [100, 60, 0, 0]);
  });

  const hits = await searchMemory(deps(), { audience: AUDIENCE, query: "holiday", limit: 10 });
  expect(hits.map((hit) => (hit.kind === "episode" ? hit.episode.id : hit.kind === "fact" ? hit.fact.id : hit.section.item))).toEqual(["2026-01-01-0040-nouva"]);
});

test("a keyword hit older than the newest few thousand is still ranked by meaning, as it was", async () => {
  db.transaction(() => {
    // Two old conversations the words find — the second says the word twice, so the words put it first — and 5,000
    // newer ones that fill the window meaning looks at. By meaning, the first is exactly what was asked.
    episode(0, HERE, "Liburan ke Bali bulan depan", [127, 0, 0, 0]);
    episode(1, HERE, "Liburan liburan", [0, 127, 0, 0]);
    for (let i = 2; i < 5_002; i += 1) episode(i, HERE, `Percakapan ${i}`, [0, 127, 0, 0]);
  });

  const hits = await searchMemory(deps(), { audience: AUDIENCE, query: "liburan", limit: 5 });
  // Both rankings agree on it, so it comes first; by words alone the other would.
  expect(hits[0]).toMatchObject({ kind: "episode", episode: { id: "2026-01-01-0000-nouva" } });
  // The two the words found and the fifteen meaning put first, one of them the same.
  expect(hydrated).toBe(16);
});
