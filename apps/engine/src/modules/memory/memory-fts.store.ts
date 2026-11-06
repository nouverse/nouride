/**
 * The memory keyword index, in SQLite's own full-text engine — `memory_fts` in `069_baseline.sql`, TD-015.
 *
 * Contentless: FTS5 keeps the index and nothing else, because the text is in the vault already — 4.3 MB
 * on a production box, where storing the text again took 14.9 MB and 0.6's hand-written term table
 * 48.5 MB. A row is only a rowid, and `memory_fts_items` maps it back to the item id memory speaks: an
 * episode id, or `fact:…`.
 *
 * Built and called by `MemoryIndexStore` inside its own transactions, so an episode and its words are
 * written together, and nothing outside the data layer sees this class. `MATCH` lives here and nowhere
 * else (`lint:sql` S5), and it only ever receives an `FtsQuery` — which only `terms.ts` can make.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { FtsDoc, FtsQuery } from "./terms.ts";

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

export class MemoryFtsStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Replace one item's words. The old row goes first: a contentless table cannot tell that a rowid it
   * is handed is already in its index, so inserting over one would leave both sets of words behind.
   */
  put(item: string, doc: FtsDoc): void {
    const id =
      this.db.prepare<{ id: number }>("SELECT id FROM memory_fts_items WHERE item = ?").get(item)?.id ??
      this.db.prepare<{ id: number }>("INSERT INTO memory_fts_items (item) VALUES (?) RETURNING id").get(item)!.id;
    this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id);
    this.db.prepare("INSERT INTO memory_fts (rowid, summary, tags, body, roots) VALUES (?, ?, ?, ?, ?)").run(id, doc.summary, doc.tags, doc.body, doc.roots);
  }

  /** Forget these items' words. */
  drop(items: readonly string[]): void {
    if (items.length === 0) return;
    const ids = this.db.prepare<{ id: number }>(`SELECT id FROM memory_fts_items WHERE item IN (${marks(items)})`).all(...items);
    const remove = this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?");
    for (const { id } of ids) remove.run(id);
    this.db.prepare(`DELETE FROM memory_fts_items WHERE item IN (${marks(items)})`).run(...items);
  }

  /**
   * Best first, and only what the caller may see: episodes through the index's own `where()` clause —
   * the same one every other episode query uses — and facts by id.
   *
   * `bm25()` is lower-is-better, so the order is ascending. The weights are per column: the summary
   * counts double, as 0.6 counted it twice, and a root counts half a word, so a word found both as
   * written and by its root does not double its score — measured against 0.6's ranking before it shipped.
   */
  rank(match: FtsQuery, scope: { sql: string; params: unknown[] }, facts: readonly string[], limit: number, collections: readonly string[] = []): string[] {
    const { sql, params } = scope;
    const fact = facts.length ? `i.item IN (${marks(facts)})` : "1 = 0";
    // Knowledge sections of the collections this conversation may search (0.8.20), in the same ranking: one query, so
    // BM25 compares a document's section with a conversation as it compares two conversations.
    const section = collections.length ? `s.collection IN (${marks(collections)})` : "1 = 0";
    return this.db
      .prepare<{ item: string }>(
        `SELECT i.item FROM memory_fts
         JOIN memory_fts_items i ON i.id = memory_fts.rowid
         LEFT JOIN memory_episodes e ON e.id = i.item
         LEFT JOIN knowledge_sections s ON s.item = i.item
         WHERE memory_fts MATCH ? AND ((e.id IS NOT NULL AND ${sql}) OR ${fact} OR (s.item IS NOT NULL AND ${section}))
         ORDER BY bm25(memory_fts, 2.0, 1.0, 1.0, 0.5) LIMIT ?`,
      )
      .all(match, ...params, ...facts, ...collections, limit)
      .map((row) => row.item);
  }

  /**
   * Knowledge sections only, best first: those of these collections (`knowledge_sections`, 0.8.20). A collection this
   * conversation may not search is never ranked, as an episode it may not see is not.
   */
  rankSections(match: FtsQuery, collections: readonly string[], limit: number): string[] {
    if (collections.length === 0) return [];
    return this.db
      .prepare<{ item: string }>(
        `SELECT i.item FROM memory_fts
         JOIN memory_fts_items i ON i.id = memory_fts.rowid
         JOIN knowledge_sections s ON s.item = i.item
         WHERE memory_fts MATCH ? AND s.collection IN (${marks(collections)})
         ORDER BY bm25(memory_fts, 2.0, 1.0, 1.0, 0.5) LIMIT ?`,
      )
      .all(match, ...collections, limit)
      .map((row) => row.item);
  }

  /** Every item the words match, unranked — the operator's word filter, and `forget`. */
  matching(match: FtsQuery, limit = 100_000): string[] {
    return this.db
      .prepare<{ item: string }>("SELECT i.item FROM memory_fts JOIN memory_fts_items i ON i.id = memory_fts.rowid WHERE memory_fts MATCH ? LIMIT ?")
      .all(match, limit)
      .map((row) => row.item);
  }

  clear(): void {
    this.db.prepare("INSERT INTO memory_fts (memory_fts) VALUES ('delete-all')").run();
    this.db.prepare("DELETE FROM memory_fts_items").run();
  }

  /** Merge FTS5's segments into one, so a search reads one b-tree rather than a night's worth — the whole index rewritten. */
  optimize(): void {
    this.db.prepare("INSERT INTO memory_fts (memory_fts) VALUES ('optimize')").run();
  }

  /**
   * Merge segments a bounded amount — about `pages` pages written — and only where a level has grown
   * enough of them to be worth it. A night's twenty documents, merged, without rewriting the rest.
   */
  merge(pages: number): void {
    this.db.prepare("INSERT INTO memory_fts (memory_fts, rank) VALUES ('merge', ?)").run(pages);
  }

  /** FTS5's check of its own index. It is a cache: a damaged one is rebuilt by `nouride memory reindex`. */
  check(): { ok: boolean; detail: string } {
    try {
      this.db.prepare("INSERT INTO memory_fts (memory_fts) VALUES ('integrity-check')").run();
      return { ok: true, detail: "ok" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
