/**
 * The knowledge base's index: what each document is and its sections (`078_knowledge.sql`), with each section's words in
 * memory's own word index (`memory_fts`, by item id), so one search ranks conversations, facts and documents together.
 *
 * A cache of the files: `syncKnowledge` writes it, a document at a time, in one transaction with its words, and a row
 * whose file is gone is dropped there.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";
import { MemoryFtsStore } from "../memory-fts.store.ts";
import { ftsDoc, type FtsQuery } from "../terms.ts";
import type { Section } from "./sections.ts";

export type DocumentStatus = "indexed" | "unreadable" | "listed";

export interface KnowledgeDocument {
  collection: string;
  path: string;
  size: number;
  mtime: number;
  title: string;
  status: DocumentStatus;
  reason?: string;
  /** The package that would read it, when one is missing: the page offers to have it installed. */
  needs?: string;
  sections: number;
  indexedAt: number;
}

export interface IndexedSection extends Section {
  item: string;
  collection: string;
  path: string;
}

/** The id memory's index and vectors know a section by. */
export function sectionItem(collection: string, path: string, n: number): string {
  return `knowledge:${collection}/${path}#${n}`;
}

/** A `knowledge:` item read back: one section, or (`#all`) the whole document. Null for anything else. */
export function parseItem(item: string): { collection: string; path: string; n: number | "all" } | null {
  const match = /^knowledge:([^/]+)\/(.+)#(all|\d+)$/.exec(item.trim());
  if (!match) return null;
  return { collection: match[1]!, path: match[2]!, n: match[3] === "all" ? "all" : Number(match[3]) };
}

interface DocumentRow {
  collection: string;
  path: string;
  size: number;
  mtime: number;
  title: string;
  status: DocumentStatus;
  reason: string | null;
  needs: string | null;
  sections: number;
  indexed_at: number;
}

interface SectionRow {
  item: string;
  collection: string;
  path: string;
  n: number;
  trail: string;
  page_from: number | null;
  page_to: number | null;
  text: string;
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

function documentOf(row: DocumentRow): KnowledgeDocument {
  return {
    collection: row.collection,
    path: row.path,
    size: row.size,
    mtime: row.mtime,
    title: row.title,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.needs ? { needs: row.needs } : {}),
    sections: row.sections,
    indexedAt: row.indexed_at,
  };
}

function sectionOf(row: SectionRow): IndexedSection {
  return {
    item: row.item,
    collection: row.collection,
    path: row.path,
    n: row.n,
    trail: row.trail,
    text: row.text,
    ...(row.page_from !== null ? { pageFrom: row.page_from } : {}),
    ...(row.page_to !== null ? { pageTo: row.page_to } : {}),
  };
}

export class KnowledgeStore {
  private readonly fts: MemoryFtsStore;
  /** Each collection's section ids, once read (`itemsOf`); a change to the collection drops its entry. */
  private readonly items = new Map<string, string[]>();

  constructor(private readonly db: SqliteDb) {
    this.fts = new MemoryFtsStore(db);
  }

  document(collection: string, path: string): KnowledgeDocument | null {
    const row = this.db.prepare<DocumentRow>("SELECT * FROM knowledge_documents WHERE collection = ? AND path = ?").get(collection, path);
    return row ? documentOf(row) : null;
  }

  /** Every document, or one collection's, by path. */
  documents(collection?: string): KnowledgeDocument[] {
    const rows = collection
      ? this.db.prepare<DocumentRow>("SELECT * FROM knowledge_documents WHERE collection = ? ORDER BY path").all(collection)
      : this.db.prepare<DocumentRow>("SELECT * FROM knowledge_documents ORDER BY collection, path").all();
    return rows.map(documentOf);
  }

  /** A document as it now reads: its row, and its sections and their words in place of the ones it had. */
  replace(document: KnowledgeDocument, sections: readonly Section[]): void {
    this.items.delete(document.collection);
    this.db.transaction(() => {
      this.dropSections(document.collection, document.path);
      const insert = this.db.prepare("INSERT INTO knowledge_sections (item, collection, path, n, trail, page_from, page_to, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const section of sections) {
        const item = sectionItem(document.collection, document.path, section.n);
        insert.run(item, document.collection, document.path, section.n, section.trail, section.pageFrom ?? null, section.pageTo ?? null, section.text);
        this.fts.put(item, ftsDoc({ summary: section.trail, body: section.text }));
      }
      this.db
        .prepare(
          `INSERT INTO knowledge_documents (collection, path, size, mtime, title, status, reason, needs, sections, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (collection, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, title = excluded.title, status = excluded.status,
             reason = excluded.reason, needs = excluded.needs, sections = excluded.sections, indexed_at = excluded.indexed_at`,
        )
        .run(document.collection, document.path, document.size, document.mtime, document.title, document.status, document.reason ?? null, document.needs ?? null, sections.length, document.indexedAt);
    });
  }

  /** A document, its sections and their words: its file is gone. */
  remove(collection: string, path: string): void {
    this.items.delete(collection);
    this.db.transaction(() => {
      this.dropSections(collection, path);
      this.db.prepare("DELETE FROM knowledge_documents WHERE collection = ? AND path = ?").run(collection, path);
    });
  }

  private dropSections(collection: string, path: string): void {
    const items = this.db.prepare<{ item: string }>("SELECT item FROM knowledge_sections WHERE collection = ? AND path = ?").all(collection, path).map((row) => row.item);
    this.fts.drop(items);
    this.db.prepare("DELETE FROM knowledge_sections WHERE collection = ? AND path = ?").run(collection, path);
  }

  /** The collections the index holds documents of: one whose folder is gone is dropped by its caller. */
  collections(): string[] {
    return this.db.prepare<{ collection: string }>("SELECT DISTINCT collection FROM knowledge_documents ORDER BY collection").all().map((row) => row.collection);
  }

  /** These sections, in the order asked, those still there. */
  sections(items: readonly string[]): IndexedSection[] {
    if (items.length === 0) return [];
    const rows = new Map(this.db.prepare<SectionRow>(`SELECT * FROM knowledge_sections WHERE item IN (${marks(items)})`).all(...items).map((row) => [row.item, row]));
    return items.flatMap((item) => {
      const row = rows.get(item);
      return row ? [sectionOf(row)] : [];
    });
  }

  /** One document's sections, in order. */
  sectionsOf(collection: string, path: string): IndexedSection[] {
    return this.db.prepare<SectionRow>("SELECT * FROM knowledge_sections WHERE collection = ? AND path = ? ORDER BY n").all(collection, path).map(sectionOf);
  }

  /**
   * The sections of these collections, by id only: what a search by meaning scores. Held per collection once read, and
   * dropped at its next change: every search asked again for tens of thousands of ids that had not moved.
   */
  itemsOf(collections: readonly string[]): string[] {
    // The collections not held yet, read in one statement and held.
    const missing = collections.filter((collection) => !this.items.has(collection));
    if (missing.length) {
      for (const collection of missing) this.items.set(collection, []);
      for (const row of this.db.prepare<{ collection: string; item: string }>(`SELECT collection, item FROM knowledge_sections WHERE collection IN (${marks(missing)})`).all(...missing)) {
        this.items.get(row.collection)!.push(row.item);
      }
    }
    return collections.flatMap((collection) => this.items.get(collection) ?? []);
  }

  /**
   * The sections whose words hold a link (`](` or `[[`), with their document: what the memory graph reads its document →
   * document lines from (`links.ts`). The rest never leave the database.
   */
  linkingTexts(): { collection: string; path: string; text: string }[] {
    return this.db
      .prepare<{ collection: string; path: string; text: string }>("SELECT collection, path, text FROM knowledge_sections WHERE instr(text, '](') > 0 OR instr(text, '[[') > 0")
      .all();
  }

  /**
   * What moves when a document is read again, added or dropped: what the graph's knowledge layer, and a search's means of
   * its documents (`search.ts`), are worked out again after.
   */
  revision(): string {
    const row = this.db.prepare<{ documents: number; at: number | null }>("SELECT COUNT(*) AS documents, MAX(indexed_at) AS at FROM knowledge_documents").get();
    return `${row?.documents ?? 0}:${row?.at ?? 0}`;
  }

  /** Every section's id and the words its vector is made from: the catch-up's list (`semantic.ts`). */
  embeddable(): { item: string; text: string }[] {
    return this.db.prepare<{ item: string; trail: string; text: string }>("SELECT item, trail, text FROM knowledge_sections").all().map((row) => ({ item: row.item, text: `${row.trail}\n${row.text}` }));
  }

  /** Best first, by words: sections of these collections only. */
  rank(match: FtsQuery, collections: readonly string[], limit: number): string[] {
    return this.fts.rankSections(match, collections, limit);
  }

  /**
   * Every section's words written again: a reindex of memory clears the whole word index (`management.reindex`), and the
   * documents are not in the vault it rebuilds from.
   */
  rewriteWords(): number {
    const rows = this.db.prepare<SectionRow>("SELECT * FROM knowledge_sections").all();
    this.db.transaction(() => {
      for (const row of rows) this.fts.put(row.item, ftsDoc({ summary: row.trail, body: row.text }));
    });
    return rows.length;
  }

  /** Documents and sections per collection, for the page and `nouride knowledge list`. */
  counts(): Map<string, { documents: number; sections: number }> {
    return new Map(
      this.db
        .prepare<{ collection: string; documents: number; sections: number }>("SELECT collection, COUNT(*) AS documents, SUM(sections) AS sections FROM knowledge_documents GROUP BY collection")
        .all()
        .map((row) => [row.collection, { documents: row.documents, sections: row.sections ?? 0 }]),
    );
  }
}

export type KnowledgePort = Port<KnowledgeStore>;
