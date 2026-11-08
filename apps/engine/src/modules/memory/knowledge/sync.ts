/**
 * The knowledge index brought in line with the folders (KNOWLEDGE_BASE §8, 0.8.20): the files are the truth.
 *
 * A file is read again only when its size or modification time moved, the way memory's vault is synced
 * (`index-sync.ts`): a scan of a few hundred documents is a stat each, not a read. A document whose file is gone is
 * dropped with its sections and their words, and so is a collection whose folder is gone. Hidden files and folders,
 * and each collection's own `knowledge.toml`, are not documents.
 */

import { createLogger } from "@nouride/shared";
import { join, listDir, statFile } from "@nouride/runtime";
import { readCollections, SETTINGS_FILE, type Collection } from "./collections.ts";
import { extract, type Extracted } from "./extract.ts";
import type { KnowledgeDocument, KnowledgePort } from "./knowledge.store.ts";
import type { OfficeReader } from "./office.ts";
import { TRAIL_MARK } from "./sections.ts";

const log = createLogger("memory.knowledge");

/** Folders below a collection's that are read: a document set, not a disk. */
const DEPTH_MAX = 6;

export interface KnowledgeSyncReport {
  indexed: number;
  unchanged: number;
  dropped: number;
  /** Kept and listed, not searched: a kind not read, or one that could not be. */
  notSearched: number;
}

/** A collection's files, as paths relative to its folder with `/` between the parts. */
function filesOf(collection: Pick<Collection, "dir">): { path: string; full: string; size: number; mtime: number }[] {
  const out: { path: string; full: string; size: number; mtime: number }[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    for (const entry of listDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (depth < DEPTH_MAX) walk(full, path, depth + 1);
        continue;
      }
      if (!entry.isFile || (!prefix && entry.name === SETTINGS_FILE)) continue;
      const stat = statFile(full);
      if (stat) out.push({ path, full, size: stat.size, mtime: Math.round(stat.mtimeMs) });
    }
  };
  walk(collection.dir, "", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A read with the title given beside the file's name (0.8.23), first in every section's trail: the trail is indexed with
 * each section, by words and by meaning, so an English title finds a document written in another language. What the
 * file says of itself stays in the trail after it, its words still found.
 */
function titled(read: Extracted, title: string | undefined): Extracted {
  if (!title || title === read.title) return read;
  if (read.kind !== "read") return { ...read, title };
  return { ...read, title, sections: read.sections.map((section) => ({ ...section, trail: `${title}${TRAIL_MARK}${section.trail}` })) };
}

function documentFrom(collection: string, file: { path: string; size: number; mtime: number }, read: Extracted, now: number): KnowledgeDocument {
  return {
    collection,
    path: file.path,
    size: file.size,
    mtime: file.mtime,
    title: read.title,
    status: read.kind === "read" ? "indexed" : read.kind,
    ...(read.kind === "read" ? (read.note ? { reason: read.note } : {}) : { reason: read.reason, ...(read.needs ? { needs: read.needs } : {}) }),
    sections: read.kind === "read" ? read.sections.length : 0,
    indexedAt: now,
    ...(read.kind === "read" && read.tags?.length ? { tags: read.tags } : {}),
  };
}

/** Bring the index in line with the folders under `root`: every collection, or the one named. */
export async function syncKnowledge(deps: { root: string; store: KnowledgePort; now: () => number; office?: OfficeReader }, only?: string): Promise<KnowledgeSyncReport> {
  const report: KnowledgeSyncReport = { indexed: 0, unchanged: 0, dropped: 0, notSearched: 0 };
  const collections = readCollections(deps.root).filter((collection) => !only || collection.id === only);
  const present = new Set(collections.map((collection) => collection.id));

  for (const collection of collections) {
    const known = new Map(deps.store.documents(collection.id).map((document) => [document.path, document]));
    for (const file of filesOf(collection)) {
      const before = known.get(file.path);
      known.delete(file.path);
      const title = collection.settings.titles?.[file.path];
      // One that waited on a program is tried again each time: the program may be installed now. One given a title since
      // it was read is read again with it, as when `knowledge.toml` is written by hand.
      if (before && before.size === file.size && before.mtime === file.mtime && !before.needs && (title === undefined || before.title === title)) {
        report.unchanged += 1;
        continue;
      }
      let read: Extracted;
      try {
        read = await extract(file.full, file.size, deps.office);
      } catch (err) {
        // Said where the document is shown, and here once: a file that cannot be read is no reason to stop the rest.
        log.warn("a knowledge document could not be read", { collection: collection.id, path: file.path, error: err instanceof Error ? err.message : String(err) });
        read = { kind: "unreadable", title: file.path, reason: "It could not be read, so it is kept here but not searched." };
      }
      read = titled(read, title);
      deps.store.replace(documentFrom(collection.id, file, read, deps.now()), read.kind === "read" ? read.sections : []);
      if (read.kind === "read") report.indexed += 1;
      else report.notSearched += 1;
    }
    // What is still known was not found: its file is gone.
    for (const gone of known.keys()) {
      deps.store.remove(collection.id, gone);
      report.dropped += 1;
    }
  }

  // A collection's folder gone: its documents go with it. Only when every collection was looked at.
  if (!only) {
    for (const collection of deps.store.collections()) {
      if (present.has(collection)) continue;
      for (const document of deps.store.documents(collection)) {
        deps.store.remove(collection, document.path);
        report.dropped += 1;
      }
    }
  }
  return report;
}
