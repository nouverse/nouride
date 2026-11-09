/**
 * Memory's vectors — the storage half of semantic search (`memory_vectors` in `069_baseline.sql`).
 *
 * One row per item and model: an episode (by id) or a fact (by its fact id), under the key of the model that made it
 * (`vectorKey` in `semantic.ts`). Which items need a vector, which model ranks, and the arithmetic, are `semantic.ts`'s.
 * Two models' vectors of one item sit side by side, so a change of model does not leave search blind by meaning while
 * the new one catches up; a hash of the text each was made from goes with it, so a rewritten summary is embedded
 * again rather than found by what it used to say. A vector is the Int8Array's own bytes, as a BLOB.
 *
 * ## Read once, then held here
 *
 * A search by meaning scores every candidate, and reading and decoding the candidates' vectors on each query was most
 * of what one cost. So a model's vectors are read from SQLite once, the first time that model is asked for, and
 * held here; every write below keeps what is held right, and a query never reads a vector from the database again.
 * That is sound because this store is the table's one writer: the daemon holds the one connection to the file, and no
 * command run beside it writes vectors.
 *
 * What it costs resident: `items × dims` bytes for each model read lately — one, but while a change of model is caught
 * up — and a map entry and a view per item. Measured at 50,000 items of 512 (24.4 MB of vectors): 30 MB of heap after a
 * collection, all in one buffer; a buffer per vector held 44 MB. Read in one query, so while it loads, briefly, twice
 * that. Not for good: a model nothing has read for `QUIET_MS` is let go (`release`), and read again by the next search
 * that wants it — a burst of conversation keeps it, an idle night does not. A vector removed takes its bytes with it:
 * what is left is packed into a buffer of its own, so a forget of thousands leaves nothing dead; one made again is
 * written over its old bytes.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";

/** How long a model's vectors stay held after the last read — the length of a quiet spell, not of a conversation. */
const QUIET_MS = 15 * 60_000;

/** The bytes a vector is stored as — a view, no copy. */
function bytesOf(vector: Int8Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** These vectors copied into one buffer, each a view into it — a buffer apiece cost half as much again (the header). */
function packed(vectors: Iterable<readonly [string, Int8Array]>): Map<string, Int8Array> {
  const entries = [...vectors];
  const slab = new Int8Array(entries.reduce((bytes, [, vector]) => bytes + vector.length, 0));
  const out = new Map<string, Int8Array>();
  let at = 0;
  for (const [item, vector] of entries) {
    const view = slab.subarray(at, at + vector.length);
    view.set(vector);
    out.set(item, view);
    at += vector.length;
  }
  return out;
}

export class MemoryVectorStore {
  /** Each model's vectors by item, for the models read lately, and when each was last read. */
  private readonly held = new Map<string, { vectors: Map<string, Int8Array>; readAt: number }>();
  /** How many vectors each model has, or null when a write has changed it since it was counted. */
  private counted: Map<string, number> | null = null;

  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** The items this model already has a vector for, with the hash of the text each was made from. */
  hashes(model: string): Map<string, string> {
    return new Map(this.db.prepare<{ item: string; text_hash: string }>("SELECT item, text_hash FROM memory_vectors WHERE model = ?").all(model).map((row) => [row.item, row.text_hash]));
  }

  /** Every vector this model made, by item: from the database the first time, from memory after. Not to be changed. */
  of(model: string): ReadonlyMap<string, Int8Array> {
    let held = this.held.get(model);
    if (!held) {
      const rows = this.db.prepare<{ item: string; vector: Uint8Array }>("SELECT item, vector FROM memory_vectors WHERE model = ?").all(model);
      held = { vectors: packed(rows.map((row) => [row.item, new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)] as const)), readAt: 0 };
      this.held.set(model, held);
    }
    held.readAt = this.now();
    return held.vectors;
  }

  /** Let go of every model's vectors nothing has read for `QUIET_MS`; the next search that wants them reads them again. */
  release(): void {
    const quiet = this.now() - QUIET_MS;
    for (const [model, held] of this.held) if (held.readAt < quiet) this.held.delete(model);
  }

  /** How many vectors each model has — read from the index once, and again only after a write. */
  counts(): ReadonlyMap<string, number> {
    this.counted ??= new Map(this.db.prepare<{ model: string; n: number }>("SELECT model, COUNT(*) AS n FROM memory_vectors GROUP BY model").all().map((row) => [row.model, row.n]));
    return this.counted;
  }

  count(model: string): number {
    return this.counts().get(model) ?? 0;
  }

  /** These items' vectors under `model`, made now. Another model's vector of the same item is left where it is. */
  put(rows: readonly { item: string; vector: Int8Array; hash: string }[], model: string, now: number): void {
    if (rows.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO memory_vectors (item, model, dims, vector, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (item, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector, text_hash = excluded.text_hash, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const row of rows) upsert.run(row.item, model, row.vector.length, bytesOf(row.vector), row.hash, now);
    });
    // Once it is written: a write that throws leaves both the table and what is held as they were.
    const held = this.held.get(model)?.vectors;
    if (held) {
      for (const row of rows) {
        // Into the bytes it had, when it had some of this size: a vector made again leaves nothing dead in the buffer.
        const before = held.get(row.item);
        if (before?.length === row.vector.length) before.set(row.vector);
        else held.set(row.item, row.vector);
      }
    }
    this.counted = null;
  }

  /** Drop these items' vectors now, every model's — a forgotten conversation must not be findable by meaning until the next catch-up. */
  remove(items: readonly string[]): number {
    if (items.length === 0) return 0;
    const removed = Number(this.db.prepare("DELETE FROM memory_vectors WHERE item IN (SELECT value FROM json_each(?))").run(JSON.stringify(items)).changes ?? 0);
    for (const held of this.held.values()) {
      const before = held.vectors.size;
      for (const item of items) held.vectors.delete(item);
      // Packed again without them: deleted from the map alone, their bytes stayed in the buffer until the model was read again.
      if (held.vectors.size < before) held.vectors = packed(held.vectors);
    }
    if (removed) this.counted = null;
    return removed;
  }

  /** Remove the vectors of items that are gone, whichever model made them — and no other (`semantic.ts`). How many went. */
  pruneGone(keep: ReadonlySet<string>): number {
    const gone = this.db.prepare<{ item: string }>("SELECT DISTINCT item FROM memory_vectors").all().map((row) => row.item).filter((item) => !keep.has(item));
    return this.remove(gone);
  }

  /** Every vector another model made, removed — once this one has every item (`semantic.ts`). How many went. */
  keepOnly(model: string): number {
    const others = [...this.counts().keys()].filter((key) => key !== model);
    if (others.length === 0) return 0;
    const removed = Number(this.db.prepare("DELETE FROM memory_vectors WHERE model IN (SELECT value FROM json_each(?))").run(JSON.stringify(others)).changes ?? 0);
    for (const key of others) this.held.delete(key);
    this.counted = null;
    return removed;
  }
}

export type MemoryVectorPort = Port<MemoryVectorStore>;
