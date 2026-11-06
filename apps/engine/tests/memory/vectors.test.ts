/**
 * The vector store: each item's vector per model, as its bytes, read from SQLite once and held in memory after — and
 * what is held kept right by every write, so a search never reads a vector from the database and never reads a stale
 * one (M5, M7 — `memory-vectors.store.ts`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let vectors: MemoryVectorStore;

beforeEach(async () => {
  dir = tempDir("vectors");
  db = await openAndMigrate(join(dir, "test.db"));
  vectors = new MemoryVectorStore(db);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const v = (...values: number[]) => Int8Array.from(values);
/** What a store opened afresh over the same file reads — the database's own answer, nothing held. */
const fromDisk = (model: string) => new Map([...new MemoryVectorStore(db).of(model)].map(([item, vector]) => [item, [...vector]]));
const held = (model: string) => new Map([...vectors.of(model)].map(([item, vector]) => [item, [...vector]]));

test("1,200 items come back whole, each its own vector, and only this model's", () => {
  const rows = Array.from({ length: 1_200 }, (_, i) => ({ item: `e${i}`, vector: v(i % 127, -(i % 128), 7), hash: "h" }));
  vectors.put(rows, "m", 1);
  vectors.put([{ item: "other", vector: v(1), hash: "h" }], "another-model", 1);

  const read = vectors.of("m");
  expect(read.size).toBe(1_200);
  expect([...read.get("e1199")!]).toEqual([1199 % 127, -(1199 % 128), 7]);
  expect(read.has("other")).toBe(false);
  expect(vectors.of("no-such-model").size).toBe(0);
});

test("a vector is stored as its bytes, not as text", () => {
  vectors.put([{ item: "e1", vector: v(1, -2, 127, -128), hash: "h" }], "m", 1);
  expect(db.prepare<{ kind: string; hex: string }>("SELECT typeof(vector) AS kind, hex(vector) AS hex FROM memory_vectors").get()).toEqual({ kind: "blob", hex: "01FE7F80" });
});

test("two models' vectors of one item are kept side by side (M7)", () => {
  vectors.put([{ item: "e1", vector: v(1, 2), hash: "h" }], "old/model@2", 1);
  vectors.put([{ item: "e1", vector: v(3, 4, 5), hash: "h" }], "new/model@3", 2);
  expect(held("old/model@2")).toEqual(new Map([["e1", [1, 2]]]));
  expect(held("new/model@3")).toEqual(new Map([["e1", [3, 4, 5]]]));
  expect([...vectors.counts()].sort()).toEqual([["new/model@3", 1], ["old/model@2", 1]]);
});

test("removing many items at once removes exactly those, every model's", () => {
  vectors.put(Array.from({ length: 600 }, (_, i) => ({ item: `e${i}`, vector: v(1), hash: "h" })), "m", 1);
  vectors.put([{ item: "e0", vector: v(2), hash: "h" }], "other", 1);
  vectors.remove(Array.from({ length: 599 }, (_, i) => `e${i}`));
  expect([...vectors.hashes("m").keys()]).toEqual(["e599"]);
  expect(vectors.count("other")).toBe(0);
});

test("once read, a model's vectors are not read from the database again — whatever is searched", () => {
  vectors.put([{ item: "e1", vector: v(1, 2), hash: "h" }], "m", 1);
  let reads = 0;
  const counting = new MemoryVectorStore({
    ...db,
    prepare: (sql: string) => {
      if (/SELECT item, vector FROM memory_vectors/.test(sql)) reads += 1;
      return db.prepare(sql);
    },
  } as SqliteDb);
  for (let i = 0; i < 5; i += 1) expect([...counting.of("m").get("e1")!]).toEqual([1, 2]);
  expect(reads).toBe(1);
});

test("what is held agrees with the database after every write — put, remove, a prune of the gone, keepOnly", () => {
  const models = ["m", "other/model@2", "p/m"];
  const agree = () => {
    for (const model of models) expect({ model, vectors: held(model) }).toEqual({ model, vectors: fromDisk(model) });
    expect(new Map(vectors.counts())).toEqual(new Map(new MemoryVectorStore(db).counts()));
  };
  // Read before any write, so every write below has something held to keep right.
  for (const model of models) vectors.of(model);
  vectors.counts();

  vectors.put([{ item: "a", vector: v(1, 1), hash: "h" }, { item: "b", vector: v(2, 2), hash: "h" }], "m", 1);
  agree();
  // The same item again: replaced, not added.
  vectors.put([{ item: "a", vector: v(9, 9), hash: "h2" }], "m", 2);
  agree();
  vectors.put([{ item: "a", vector: v(5, 5), hash: "h" }, { item: "c", vector: v(6, 6), hash: "h" }], "other/model@2", 1);
  agree();
  vectors.remove(["b"]);
  agree();
  expect(vectors.pruneGone(new Set(["a"]))).toBe(1);
  agree();
  expect(held("m")).toEqual(new Map([["a", [9, 9]]]));
  expect(vectors.keepOnly("m")).toBe(1);
  agree();
  expect([...vectors.counts()]).toEqual([["m", 1]]);
});

test("a model nothing has read for a quiet spell is let go, and read again by the next search that wants it", () => {
  const clock = { now: 0 };
  let reads = 0;
  const store = new MemoryVectorStore(
    {
      ...db,
      prepare: (sql: string) => {
        if (/SELECT item, vector FROM memory_vectors/.test(sql)) reads += 1;
        return db.prepare(sql);
      },
    } as SqliteDb,
    () => clock.now,
  );
  store.put([{ item: "e1", vector: v(1, 2), hash: "h" }], "m", 1);
  store.of("m");
  clock.now = 14 * 60_000;
  store.release();
  // Read again a minute before it would go: held, and its quiet spell starts over.
  expect([...store.of("m").get("e1")!]).toEqual([1, 2]);
  clock.now = 28 * 60_000;
  store.release();
  store.of("m");
  expect(reads).toBe(1);
  clock.now = 44 * 60_000;
  store.release();
  expect([...store.of("m").get("e1")!]).toEqual([1, 2]);
  expect(reads).toBe(2);
});

test("a vector removed takes its bytes with it — what is left is held in a buffer of its own size", () => {
  vectors.put(Array.from({ length: 1_000 }, (_, i) => ({ item: `e${i}`, vector: v(i % 127, 1, 2, 3), hash: "h" })), "m", 1);
  vectors.of("m");
  vectors.remove(Array.from({ length: 900 }, (_, i) => `e${i}`));
  const left = vectors.of("m");
  expect(left.size).toBe(100);
  expect(new Set([...left.values()].map((vector) => vector.buffer)).size).toBe(1);
  expect(left.values().next().value!.buffer.byteLength).toBe(100 * 4);
  expect([...left.get("e999")!]).toEqual([999 % 127, 1, 2, 3]);
});

test("a write that fails leaves what is held as it was", () => {
  vectors.put([{ item: "a", vector: v(1, 1), hash: "h" }], "m", 1);
  vectors.of("m");
  // A row the table refuses half-way through the batch: the batch is one transaction, so none of it is written.
  expect(() => vectors.put([{ item: "a", vector: v(2, 2), hash: "h" }, { item: null as unknown as string, vector: v(3, 3), hash: "h" }], "m", 2)).toThrow();
  expect(held("m")).toEqual(new Map([["a", [1, 1]]]));
  expect(fromDisk("m")).toEqual(new Map([["a", [1, 1]]]));
});
