/**
 * The knowledge base as memory's one surface offers it (0.8.20, KNOWLEDGE_BASE): which collections an agent may search
 * in a conversation, a section opened, and what the dashboard and the command line read and change. Here rather than in
 * `index.ts`, which keeps memory's own; the search that ranks sections with conversations is `search.ts`'s.
 */

import type { Person } from "@nouride/shared";
import type { Audience } from "../access.ts";
import { buildKnowledgeLayer, type KnowledgeLayer } from "../graph-view.ts";
import type { CatchUpReport, Semantic } from "../semantic.ts";
import { fuse, rankByMeaning, rankingModel, rankingVectors } from "../semantic.ts";
import { ftsQuery } from "../terms.ts";
import { mayUse, readCollection, readCollections, type Collection, type CollectionSettings } from "./collections.ts";
import { addDocument, approvePending, createCollection, declinePending, pendingOf, removeCollection, removeDocument, writeNote, writeSettings, writeTitle, type KnowledgeRefusal, type PendingDocument } from "./files.ts";
import { keepFromChat, keptFile, type Keeping, type KeepRequest, type KeepResult } from "./kept.ts";
import { parseItem, type IndexedSection, type KnowledgeDocument, type KnowledgePort } from "./knowledge.store.ts";
import type { OfficeReader } from "./office.ts";
import { documentIndex, linksIn, resolveLink } from "./links.ts";
import { documentKey, documentOf, documentVectors, nearest } from "./related.ts";
import { syncKnowledge, type KnowledgeSyncReport } from "./sync.ts";

export interface KnowledgeDeps {
  /** `.nouride/knowledge/`. */
  root: string;
  store: KnowledgePort;
  /** The people whose dashboard account is an admin's: a folder with no settings is theirs. */
  admins: () => readonly string[];
  /**
   * The wait for room on the box before each batch of embeddings, when there is one (0.8.0's): set once the box's load
   * is read, after memory is built (the daemon's `index.ts`).
   */
  room?: { wait?: () => Promise<unknown> };
  /** Where `doc.py` is, to read PDF and Office files; without it they are kept and listed. */
  office?: OfficeReader;
}

/** A collection as the dashboard and the command line list it: its settings, and what its index holds. */
export interface CollectionView extends Collection {
  documents: number;
  sections: number;
}

/** A document close to another in meaning: the dashboard's **Related documents**. */
export interface RelatedDocument {
  collection: string;
  collectionName: string;
  path: string;
  title: string;
  /** The cosine of the two documents' mean vectors. */
  score: number;
}

/** Who is asking: the agent, and what its conversation may see. */
export type { KeepRequest, KeepResult } from "./kept.ts";

export interface Asker {
  agentId: string;
  audience: Audience;
}

export function createKnowledge(input: {
  knowledge?: KnowledgeDeps;
  now: () => number;
  /** Search by meaning as it stands, or null. */
  semantic: () => Semantic | null;
  /** Whether there is a model to embed with now. */
  embeds: () => boolean;
  embedCatchUp: (room?: () => Promise<unknown>) => Promise<CatchUpReport | null>;
}) {
  const deps = { knowledge: input.knowledge };
  const { now, embedCatchUp, semantic: semanticNow } = input;

  /** The collections this agent may search in this conversation (`mayUse`): none without a knowledge base. */
  function usableCollections(asker: Asker): Collection[] {
    const knowledge = deps.knowledge;
    if (!knowledge) return [];
    const admins = knowledge.admins();
    return readCollections(knowledge.root).filter((collection) => mayUse(collection, { agentId: asker.agentId, audience: asker.audience, admins }));
  }

  /** One sync of the knowledge index at a time: two would read the same files and write the same rows. */
  let syncing: Promise<KnowledgeSyncReport> | null = null;
  async function syncKnowledgeNow(only?: string): Promise<KnowledgeSyncReport> {
    const knowledge = deps.knowledge;
    if (!knowledge) return { indexed: 0, unchanged: 0, dropped: 0, notSearched: 0 };
    while (syncing) await syncing.catch(() => undefined);
    const run = syncKnowledge({ root: knowledge.root, store: knowledge.store, now, ...(knowledge.office ? { office: knowledge.office } : {}) }, only);
    syncing = run;
    try {
      const report = await run;
      // New words to find by meaning: embedded in the background, waiting while the box is busy, never in the way.
      if (report.indexed && input.embeds()) void embedKnowledge();
      return report;
    } finally {
      if (syncing === run) syncing = null;
    }
  }

  /** Catch-ups until every section has a vector, or the provider fails: one run embeds at most a few thousand. */
  async function embedKnowledge(): Promise<void> {
    for (let runs = 0; runs < 50; runs++) {
      const wait = deps.knowledge?.room?.wait;
      const report = await embedCatchUp(wait).catch(() => null);
      if (!report || report.failed || report.waiting === 0) return;
    }
  }

  /**
   * A knowledge section, or (`#all`) its whole document, if this agent may search its collection here. Read from the
   * index's text, never from the file: what search found is what is opened.
   */
  function read(asker: Asker, item: string): { collection: string; about: readonly string[]; title: string; path: string; sections: IndexedSection[] } | { refused: string } {
    const parsed = parseItem(item);
    const knowledge = deps.knowledge;
    const nothing = { refused: `no document "${item}" that this chat may read` };
    if (!parsed || !knowledge) return nothing;
    const collection = usableCollections(asker).find((candidate) => candidate.id === parsed.collection);
    if (!collection) return nothing;
    const document = knowledge.store.document(parsed.collection, parsed.path);
    const all = knowledge.store.sectionsOf(parsed.collection, parsed.path);
    const sections = parsed.n === "all" ? all : all.filter((section) => section.n === parsed.n);
    if (!document || sections.length === 0) return nothing;
    return { collection: collection.settings.name, about: collection.settings.about, title: document.title, path: document.path, sections };
  }

  /** A document kept from a chat, and a kept file handed back to one: `kept.ts`. */
  const keeping = (knowledge: KnowledgeDeps): Keeping => ({ knowledge, usable: usableCollections, sync: syncKnowledgeNow, now });
  const keep = async (asker: Asker, request: KeepRequest): Promise<KeepResult> => (deps.knowledge ? await keepFromChat(keeping(deps.knowledge), asker, request) : { refused: "This Nouride keeps no knowledge base." });
  const fileOf = (asker: Asker, item: string) => (deps.knowledge ? keptFile(keeping(deps.knowledge), asker, item) : { refused: `no document "${item}" that this chat may read` });

  /**
   * The memory graph's knowledge layer as last built, and what it was built from: built again only when a document was
   * read, added or dropped, a collection's settings changed, or the vectors that rank by meaning grew. A section written
   * again in place keeps its count of vectors, so its dashed lines catch up at the next of those.
   */
  let layered: { key: string; layer: KnowledgeLayer } | null = null;

  const surface = {
    /** Documents saved from a chat that wait for an admin's yes. */
    pending: (id: string): PendingDocument[] => (deps.knowledge ? pendingOf(deps.knowledge.root, id) : []),
    /** An admin's yes: the document joins its collection and is read. */
    async approve(id: string, path: string): Promise<{ path: string; document: KnowledgeDocument | null } | null> {
      const knowledge = deps.knowledge;
      const waiting = knowledge ? pendingOf(knowledge.root, id).find((document) => document.path === path) : undefined;
      const joined = knowledge ? approvePending(knowledge.root, id, path) : null;
      if (!knowledge || !joined) return null;
      // The title it was kept with goes with it, unless it was only its name: a page's is its heading already.
      if (waiting && waiting.title !== path && waiting.title !== path.replace(/\.[^.]+$/, "")) await writeTitle(knowledge.root, id, joined, waiting.title);
      await syncKnowledgeNow(id);
      return { path: joined, document: knowledge.store.document(id, joined) };
    },
    decline: (id: string, path: string): boolean => (deps.knowledge ? declinePending(deps.knowledge.root, id, path) : false),
    /** Whether this daemon keeps one: a folder and an index. */
    enabled: (): boolean => deps.knowledge !== undefined,
    /** Every collection, archived ones too, with what its index holds. */
    collections(): CollectionView[] {
      const knowledge = deps.knowledge;
      if (!knowledge) return [];
      const counts = knowledge.store.counts();
      return readCollections(knowledge.root).map((collection) => ({ ...collection, documents: counts.get(collection.id)?.documents ?? 0, sections: counts.get(collection.id)?.sections ?? 0 }));
    },
    collection(id: string): Collection | null {
      const knowledge = deps.knowledge;
      if (!knowledge) return null;
      return readCollections(knowledge.root).find((collection) => collection.id === id) ?? null;
    },
    documents: (collection: string): KnowledgeDocument[] => deps.knowledge?.store.documents(collection) ?? [],
    document: (collection: string, path: string): KnowledgeDocument | null => deps.knowledge?.store.document(collection, path) ?? null,
    sectionsOf: (collection: string, path: string): IndexedSection[] => deps.knowledge?.store.sectionsOf(collection, path) ?? [],
    sync: (only?: string): Promise<KnowledgeSyncReport> => syncKnowledgeNow(only),
    /**
     * Sections of every collection, or one, that match: by words and by meaning, fused as memory's search fuses them.
     * For whoever runs the box (the page, the command line), so not bounded by a conversation; an agent's search is.
     */
    async search(query: string, only?: string): Promise<(IndexedSection & { collectionName: string; score: number })[]> {
      const knowledge = deps.knowledge;
      if (!knowledge) return [];
      const collections = readCollections(knowledge.root).filter((collection) => !only || collection.id === only);
      const ids = collections.map((collection) => collection.id);
      const match = ftsQuery(query);
      const byWords = match ? knowledge.store.rank(match, ids, 50) : [];
      const semantic = semanticNow();
      const byMeaning = semantic ? ((await rankByMeaning(semantic, query, knowledge.store.itemsOf(ids)))?.slice(0, 30).map((hit) => hit.item) ?? []) : [];
      const ordered = [...(byMeaning.length ? fuse([byWords, byMeaning], { exact: byWords }) : fuse([byWords]))].sort((a, b) => b[1] - a[1]).slice(0, 20);
      const sections = new Map(knowledge.store.sections(ordered.map(([item]) => item)).map((section) => [section.item, section]));
      const names = new Map(collections.map((collection) => [collection.id, collection.settings.name]));
      return ordered.flatMap(([item, score]) => {
        const section = sections.get(item);
        return section ? [{ ...section, collectionName: names.get(section.collection) ?? section.collection, score }] : [];
      });
    },
    /**
     * A document's nearest by meaning (the **Related documents**), among the documents of every collection not archived
     * and its own: the mean of its sections' vectors against each other document's, from the vectors search holds. None,
     * and `byMeaning` false, while search by meaning is off; none either before its sections have their vectors.
     */
    related(collection: string, path: string): { byMeaning: boolean; related: RelatedDocument[] } {
      const knowledge = deps.knowledge;
      const semantic = semanticNow();
      if (!knowledge || !semantic) return { byMeaning: false, related: [] };
      const names = new Map(
        readCollections(knowledge.root)
          .filter((candidate) => !candidate.settings.archived || candidate.id === collection)
          .map((candidate) => [candidate.id, candidate.settings.name]),
      );
      // Among the documents that were read, and the one asked about: a file found by its title alone has too little to
      // be near by, and stood in the place of a document that was.
      const own = documentKey(collection, path);
      const wasRead = new Set(knowledge.store.documents().filter((document) => document.status === "indexed").map((document) => documentKey(document.collection, document.path)));
      const means = new Map([...documentVectors(knowledge.store.itemsOf([...names.keys()]), rankingVectors(semantic))].filter(([key]) => key === own || wasRead.has(key)));
      const related = nearest(own, means).flatMap(({ key, score }) => {
        const at = documentOf(key);
        const document = knowledge.store.document(at.collection, at.path);
        return document ? [{ collection: at.collection, collectionName: names.get(at.collection) ?? at.collection, path: at.path, title: document.title, score }] : [];
      });
      return { byMeaning: true, related };
    },
    /**
     * The memory graph's knowledge layer: the collections not archived, their documents that were read, the links
     * between them, whom they are about, and each one's nearest by meaning while search by meaning is on. Null without a
     * knowledge base.
     */
    layer(limit: number, people: readonly Person[]): KnowledgeLayer | null {
      const knowledge = deps.knowledge;
      if (!knowledge) return null;
      const collections = readCollections(knowledge.root).filter((collection) => !collection.settings.archived);
      const semantic = semanticNow();
      const model = semantic ? rankingModel(semantic.vectors, semantic.embedder.model) : null;
      const key = JSON.stringify([
        knowledge.store.revision(),
        collections.map((collection) => [collection.id, collection.settings.name, collection.settings.about]),
        model && semantic ? [model, semantic.vectors.count(model)] : null,
        people.map((person) => [person.key, person.name]),
        limit,
      ]);
      if (layered?.key === key) return layered.layer;
      const ids = collections.map((collection) => collection.id);
      const shown = new Set(ids);
      const documents = knowledge.store.documents().filter((document) => document.status === "indexed" && shown.has(document.collection));
      const index = documentIndex(documents);
      const links = knowledge.store.linkingTexts().flatMap(({ collection, path, text }) =>
        linksIn(text).flatMap((link) => {
          const to = resolveLink({ collection, path }, link, index);
          return to ? [[documentKey(collection, path), to] as const] : [];
        }),
      );
      const layer = buildKnowledgeLayer(
        {
          collections: collections.map((collection) => ({ id: collection.id, name: collection.settings.name, about: collection.settings.about })),
          documents,
          links,
          ...(semantic ? { vectors: documentVectors(knowledge.store.itemsOf(ids), rankingVectors(semantic)) } : {}),
        },
        limit,
        people,
      );
      layered = { key, layer };
      return layer;
    },
    async create(id: string, settings: CollectionSettings): Promise<Collection | KnowledgeRefusal> {
      if (!deps.knowledge) return { refused: "This Nouride keeps no knowledge base.", why: "missing" };
      return await createCollection(deps.knowledge.root, id, settings);
    },
    async configure(id: string, settings: CollectionSettings): Promise<Collection | KnowledgeRefusal> {
      if (!deps.knowledge) return { refused: "This Nouride keeps no knowledge base.", why: "missing" };
      const written = await writeSettings(deps.knowledge.root, id, settings);
      return "refused" in written ? written : readCollection(deps.knowledge.root, id);
    },
    /** A document's bytes into a collection, then that collection synced: what it was saved as, and how it reads. */
    async add(id: string, name: string, bytes: Uint8Array): Promise<{ path: string; document: KnowledgeDocument | null } | KnowledgeRefusal> {
      if (!deps.knowledge) return { refused: "This Nouride keeps no knowledge base.", why: "missing" };
      const saved = await addDocument(deps.knowledge.root, id, name, bytes);
      if ("refused" in saved) return saved;
      await syncKnowledgeNow(id);
      return { path: saved.path, document: deps.knowledge.store.document(id, saved.path) };
    },
    async remove(id: string, path: string): Promise<boolean> {
      if (!deps.knowledge || !removeDocument(deps.knowledge.root, id, path)) return false;
      if (readCollection(deps.knowledge.root, id).settings.titles?.[path] !== undefined) await writeTitle(deps.knowledge.root, id, path, null);
      if (readCollection(deps.knowledge.root, id).settings.notes?.[path] !== undefined) await writeNote(deps.knowledge.root, id, path, null);
      await syncKnowledgeNow(id);
      return true;
    },
    /**
     * A document's title set, or taken off with null (0.8.23), and the document read again with it: its sections' trails
     * carry it into search. The file keeps its name.
     */
    async retitle(id: string, path: string, title: string | null): Promise<{ document: KnowledgeDocument | null } | KnowledgeRefusal> {
      const knowledge = deps.knowledge;
      if (!knowledge) return { refused: "This Nouride keeps no knowledge base.", why: "missing" };
      if (!knowledge.store.document(id, path)) return { refused: `There is no document "${path}" in "${id}".`, why: "missing" };
      const written = await writeTitle(knowledge.root, id, path, title);
      if ("refused" in written) return written;
      // Taken off, the title the file gives itself comes back only from a read: the row goes, and the sync reads it anew.
      if (title === null) knowledge.store.remove(id, path);
      await syncKnowledgeNow(id);
      return { document: knowledge.store.document(id, path) };
    },
    async removeCollection(id: string): Promise<boolean> {
      if (!deps.knowledge || !removeCollection(deps.knowledge.root, id)) return false;
      await syncKnowledgeNow();
      return true;
    },
  };

  return { usable: usableCollections, read, keep, fileOf, surface };
}
