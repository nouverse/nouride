/**
 * A sweep over the whole vault — the vector catch-up, a forget, the tag tidy's plan — reads its episodes a page at a
 * time (`MemoryIndexStore.pages`). Each asked for a million at once, so on a large vault each held every episode
 * whole, its ids bound into one statement, before it looked at the first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTagTools } from "@/modules/memory/memory-tags.ts";
import { forgetPerson } from "@/modules/memory/forget.ts";
import { MemoryAnalyticsStore } from "@/modules/memory/memory-analytics.store.ts";
import { MemoryIndexStore, type IndexedEpisode } from "@/modules/memory/memory-index.store.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { catchUp } from "@/modules/memory/semantic.ts";
import { ftsDoc } from "@/modules/memory/terms.ts";
import { household, type Household } from "./fixture.ts";

const SIZE = 1_200;
const START = Date.UTC(2026, 0, 1);
/** A forget rewrites all 1,200 episodes' files: under a second alone, past bun's 5 s beside a loaded full run. */
const FORGET_MS = 30_000;

let h: Household;
let index: MemoryIndexStore;
/** The episodes each read of the index handed back at once. */
let reads: number[];

beforeEach(async () => {
  h = await household();
  const store = new MemoryIndexStore(h.db);
  h.db.transaction(() => {
    for (let i = 0; i < SIZE; i += 1) {
      // Two to an hour, so pages break inside a run of equal start times as well as between them.
      const startedAt = START + Math.floor(i / 2) * 3_600_000;
      const day = new Date(startedAt).toISOString().slice(0, 10);
      const episode: IndexedEpisode = {
        id: `2026-01-01-0000-n${String(i).padStart(4, "0")}`, status: "summarized", kind: "dm", chat: "telegram:nouva:814", day, week: "2026-W01", month: day.slice(0, 7),
        startedAt, endedAt: startedAt + 60_000, summary: `Conversation ${i}.`, agents: ["nouva"], participants: ["gading"], mentions: [], tags: [`tag${i % 7}`], related: [],
      };
      store.putEpisode(episode, ftsDoc({ summary: episode.summary! }), { path: `episodes/${episode.id}.md`, state: { mtimeMs: startedAt, size: 1 } });
    }
  });
  reads = [];
  index = new Proxy(store, {
    get(target, key) {
      if (key === "allEpisodes") {
        return (...args: Parameters<MemoryIndexStore["allEpisodes"]>) => {
          const found = target.allEpisodes(...args);
          reads.push(found.length);
          return found;
        };
      }
      if (key === "pages") {
        return function* (...args: Parameters<MemoryIndexStore["pages"]>) {
          for (const page of target.pages(...args)) {
            reads.push(page.length);
            yield page;
          }
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
});

afterEach(() => h.close());

describe("a sweep over every episode", () => {
  test("the vector catch-up: every summary embedded, no read past a page", async () => {
    const report = await catchUp({ index, vectors: h.vectors, embedder: { model: "fake/m@2", embed: async (texts) => texts.map(() => [1, 0]) }, now: () => 1 });
    expect(report).toMatchObject({ embedded: SIZE, failed: false });
    expect(Math.max(...reads)).toBeLessThanOrEqual(500);
  });

  test("the tag tidy's plan: every tag counted, no read past a page", () => {
    const tags = createTagTools({ vault: h.vault, index, analytics: new MemoryAnalyticsStore(h.db), now: () => 1, busy: () => null, exclusive: (_what, run) => run() });
    expect(tags.plan()).toMatchObject({ tags: 7 });
    expect(reads.reduce((sum, n) => sum + n, 0)).toBe(SIZE);
    expect(Math.max(...reads)).toBeLessThanOrEqual(500);
  });

  test("a forget: every conversation they took part in found, no read past a page", async () => {
    const report = await forgetPerson({ vault: h.vault, index, state: new MemoryStateStore(h.db), vectors: h.vectors, now: () => 1 }, { key: "gading", name: "Gading" }, "anonymize");
    expect(report.episodesDeleted).toBe(SIZE);
    expect(Math.max(...reads)).toBeLessThanOrEqual(500);
  }, FORGET_MS);
});

describe("pages", () => {
  test("hand back every episode once, newest first — ties by id — whatever the page size", () => {
    const all = [...index.pages({}, 7)].flat().map((episode) => episode.id);
    expect(all).toHaveLength(SIZE);
    expect(new Set(all).size).toBe(SIZE);
    expect(all.slice(0, 3)).toEqual(["2026-01-01-0000-n1199", "2026-01-01-0000-n1198", "2026-01-01-0000-n1197"]);
    expect(all).toEqual(index.allEpisodes({}, SIZE).map((episode) => episode.id).sort((a, b) => b.localeCompare(a)));
  });

  test("an episode removed while they are read is not handed back, and none is handed back twice", () => {
    const seen: string[] = [];
    for (const page of index.pages({}, 100)) {
      seen.push(...page.map((episode) => episode.id));
      // The oldest goes while the newest are still being read.
      if (seen.length === 100) index.dropEpisode("2026-01-01-0000-n0000", "episodes/2026-01-01-0000-n0000.md");
    }
    expect(seen).toHaveLength(SIZE - 1);
    expect(new Set(seen).size).toBe(SIZE - 1);
  });
});
