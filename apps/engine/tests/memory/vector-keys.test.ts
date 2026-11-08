/**
 * What a vector is recorded under, and what becomes of the old ones when that changes.
 *
 * The size asked of a model is part of the key, so a change of `dimensions` embeds everything again rather than
 * leaving vectors no query can be compared with. And a change of model keeps the old model's vectors beside the new
 * one's: the old one ranks searches — its query embedded by it — until the new one has every item, and only then do
 * its vectors go.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { addLogSink } from "@nouride/shared";
import type { MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { catchUp, parseVectorKey } from "@/modules/memory/semantic.ts";
import { GADING_DM, at, household, scripted, speaker, type Household } from "./fixture.ts";

let s: Household;
let reachable = true;
/** Models that cannot be reached, by name — the one before a change, gone. */
let gone = new Set<string>();
/** Each embedding asked for, by the model asked and what it was asked to embed. */
let asked: { model: string; texts: string[] }[] = [];
afterEach(() => {
  s.close();
  reachable = true;
  gone = new Set();
  asked = [];
});

/**
 * A toy space of whatever size is asked: the Bali trip and "holiday" on one axis, everything else on the next. `vec2`
 * swaps the two axes — so a query embedded by one model and compared with the other's vectors finds the wrong one.
 */
function embed(texts: string[], semantic: { model: string; dimensions: number }): number[][] | null {
  asked.push({ model: semantic.model, texts });
  if (!reachable || gone.has(semantic.model)) return null;
  const travel = semantic.model === "vec2" ? 1 : 0;
  return texts.map((text) => Array.from({ length: semantic.dimensions }, (_, i) => (i === (/bali|liburan|holiday/i.test(text) ? travel : 1 - travel) ? 1 : 0)));
}

const BALI = "2026-09-25-0900-nouva";
const LAMP = "2026-09-25-1000-nouva";

/** Two conversations filed and embedded, at `fake/vec@4`. */
async function embedded(): Promise<void> {
  s = await household({ embed });
  s.dm(GADING_DM, "nouva", "Aku mau liburan ke Bali", "Oke.", at(9));
  s.dm({ ...GADING_DM, chatId: "900" }, "nouva", "Lampu teras", "Jam 22.", at(10));
  await s.memory.pass(scripted([{ when: "Bali", answer: { summary: "Rencana liburan Bali." } }, { when: "Lampu", answer: { summary: "Lampu teras." } }]).ask);
  expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 2, failed: false });
}

/** What the file holds — a store of its own, nothing held in memory. */
const onDisk = () => new MemoryVectorStore(s.db);
const holiday = async (memory = s.memory) => (await memory.search(speaker(GADING_DM), { query: "holiday" }))[0];
/** The models a query was embedded by, in order — the catch-up's batches are not queries. */
const queriedBy = () => asked.filter((call) => call.texts.length === 1 && call.texts[0] === "holiday").map((call) => call.model);

describe("the size is part of the key (M6)", () => {
  test("a change of dimensions embeds everything again, at the new size", async () => {
    await embedded();
    s.config.memory.semantic.dimensions = 8;

    // The texts did not change; the size did. Under a key without it, nothing was redone and every cosine was 0.
    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 2, failed: false });
    expect(onDisk().count("fake/vec@8")).toBe(2);
    expect(await holiday()).toMatchObject({ kind: "episode", episode: { summary: "Rencana liburan Bali." } });
  });
});

describe("a change of model (M7)", () => {
  test("the model before ranks — its query embedded by it — until the new one has every item; then its vectors go", async () => {
    await embedded();
    s.config.memory.semantic.model = "vec2";
    // The new model has one of the two so far, as after a night's catch-up that did not reach the end.
    s.vectors.put([{ item: LAMP, vector: Int8Array.from([127, 0, 0, 0]), hash: s.vectors.hashes("fake/vec@4").get(LAMP)! }], "fake/vec2@4", 1);

    // By the new model it would be the lamp: its query is on the other axis. By the old one, the trip.
    expect(await holiday()).toMatchObject({ kind: "episode", episode: { summary: "Rencana liburan Bali." } });
    expect(queriedBy()).toEqual(["vec"]);
    expect(s.memory.semanticStatus()).toMatchObject({ model: "fake/vec2@4", items: 1, ranking: { model: "fake/vec@4", items: 2 } });

    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 1, superseded: 2, waiting: 0, failed: false });
    expect([...onDisk().counts()]).toEqual([["fake/vec2@4", 2]]);
    expect(s.memory.semanticStatus().ranking).toBeUndefined();
    asked = [];
    expect(await holiday()).toMatchObject({ kind: "episode", episode: { summary: "Rencana liburan Bali." } });
    expect(queriedBy()).toEqual(["vec2"]);
  });

  test("a catch-up that does not reach every item removes nothing of the model before", async () => {
    await embedded();
    s.config.memory.semantic.model = "vec2";
    reachable = false;

    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 0, superseded: 0, failed: true });
    expect(onDisk().count("fake/vec@4")).toBe(2);
  });

  test("nor does one that stops at a night's 2,000 with an item still to do", async () => {
    s = await household();
    const wanted = Array.from({ length: 2_001 }, (_, i) => ({ id: `e${i}`, summary: `Percakapan ${i}`, tags: [] }));
    s.vectors.put(wanted.map((episode) => ({ item: episode.id, vector: Int8Array.from([127, 0]), hash: "old" })), "old/model@2", 1);
    const index = { *pages() { yield wanted; }, facts: () => [], subjects: () => [] } as unknown as MemoryIndexPort;
    const embedder = { model: "new/model@2", embed: async (texts: string[]) => texts.map(() => [0, 1]) };

    expect(await catchUp({ index, vectors: s.vectors, embedder, now: () => 1 })).toMatchObject({ embedded: 2_000, superseded: 0, waiting: 1, failed: false });
    expect(onDisk().count("old/model@2")).toBe(2_001);
  });

  test("a model before that cannot be asked any more: the model in use ranks with what it has, and the old one is left alone a while", async () => {
    await embedded();
    s.config.memory.semantic.model = "vec2";
    s.vectors.put([{ item: BALI, vector: Int8Array.from([0, 127, 0, 0]), hash: s.vectors.hashes("fake/vec@4").get(BALI)! }], "fake/vec2@4", 1);
    gone = new Set(["vec"]);

    expect(await holiday()).toMatchObject({ kind: "episode", episode: { summary: "Rencana liburan Bali." } });
    expect(queriedBy()).toEqual(["vec", "vec2"]);
    // Not asked again for each search: a provider that is gone would cost every one a failed call first.
    asked = [];
    await holiday();
    expect(queriedBy()).toEqual(["vec2"]);
    expect(s.memory.semanticStatus().ranking).toBeUndefined();

    // A quarter of an hour on, it is asked again — and, back, ranks again.
    gone = new Set();
    s.clock.now += 15 * 60_000;
    asked = [];
    await holiday();
    expect(queriedBy()).toEqual(["vec"]);
  });

  test("one that cannot be reached deletes nothing: switching back finds every vector where it was", async () => {
    await embedded();
    s.config.memory.semantic.model = "vec2";
    reachable = false;

    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 0, failed: true });
    expect(onDisk().count("fake/vec@4")).toBe(2);

    s.config.memory.semantic.model = "vec";
    reachable = true;
    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 0, pruned: 0, failed: false });
    expect(await holiday()).toMatchObject({ kind: "episode", episode: { summary: "Rencana liburan Bali." } });
  });

  test("what is gone still goes at once, whichever model made it", async () => {
    await embedded();
    s.vectors.put([{ item: "2026-01-01-0000-nouva", vector: new Int8Array(4), hash: "h" }], "another/model@4", 1);

    expect(await s.memory.embedCatchUp()).toMatchObject({ embedded: 0, pruned: 1 });
    expect(onDisk().count("another/model@4")).toBe(0);
  });
});

describe("a vector key read back", () => {
  test("names its provider, model and size — a model with a slash or an @ in its name whole — or nothing without a size", () => {
    expect(parseVectorKey("ollama/bge-m3@1024")).toEqual({ provider: "ollama", model: "bge-m3", dimensions: 1024 });
    expect(parseVectorKey("nougate/openai/text-embedding-3-small@512")).toEqual({ provider: "nougate", model: "openai/text-embedding-3-small", dimensions: 512 });
    expect(parseVectorKey("cf/@cf/baai/bge-base-en-v1.5@768")).toEqual({ provider: "cf", model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 });
    for (const key of ["fake/vec", "fake/vec@", "fake/vec@0", "fake/vec@x", "/vec@4", "fake/@4", "vec@4"]) expect({ key, parsed: parseVectorKey(key) }).toEqual({ key, parsed: null });
  });
});

describe("a catch-up that throws", () => {
  test("is in the log, for the callers that started it in the background and cannot hear it", async () => {
    // Not a provider that fails — that is reported as `failed` — but what nothing caught: the dashboard's Embed
    // button starts it with `.catch(() => null)`, and a thrown error left no line anywhere.
    const said: string[] = [];
    addLogSink((entry) => {
      if (entry.level === "warn") said.push(`${entry.message} ${JSON.stringify(entry.data ?? {})}`);
    });
    s = await household({
      embed: () => {
        throw new Error("database is locked");
      },
    });
    s.dm(GADING_DM, "nouva", "Aku mau liburan ke Bali", "Oke.", at(9));
    await s.memory.pass(scripted([{ when: "Bali", answer: { summary: "Rencana liburan Bali." } }]).ask);
    await expect(s.memory.embedCatchUp()).rejects.toThrow("database is locked");
    expect(said.some((line) => line.includes("memory embedding catch-up failed") && line.includes("database is locked"))).toBe(true);
  });
});
