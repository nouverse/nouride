/**
 * The knowledge base's calls (0.8.20, KNOWLEDGE_BASE §11): its collections, their documents, what search finds in them,
 * and the documents an agent saved from a chat that wait for an admin's yes. Spread into `api` like the other menus'.
 * The types are the engine's (`routes/knowledge.ts`), written again: the dashboard is its own build.
 */

import { control, post, request } from "./api.client";

/** Who may be answered from a collection: in a conversation, every person in it must be one of them. */
export type KnowledgeReaders =
  | { kind: "everyone" }
  /** The people whose dashboard account is an admin's: a folder made by hand, until somebody says otherwise. */
  | { kind: "admins" }
  | { kind: "people"; people: string[] }
  /** One group chat, by memory's key for it: `<connection>:<chat>`. */
  | { kind: "group"; chat: string };

export interface KnowledgeCollection {
  /** Its folder's name, and its id in every route. */
  id: string;
  name: string;
  description: string;
  readers: KnowledgeReaders;
  /** The agents that look in it; null for every agent. */
  agents: string[] | null;
  /** Whom it is about, by person key. It lets nobody read it. */
  about: string[];
  /** Kept, never searched. */
  archived: boolean;
  documents: number;
  sections: number;
  /** What of its settings could not be read; its defaults stand until it is fixed. */
  problem?: string;
}

/** Read and searched; kept but not read, and why (`unreadable`); a kind Nouride does not read (`listed`). */
export type DocumentStatus = "indexed" | "unreadable" | "listed";

export interface KnowledgeDocument {
  collection: string;
  /** Where it is in its collection: its file's name, in a folder of the collection where it has one. */
  path: string;
  size: number;
  mtime: number;
  title: string;
  status: DocumentStatus;
  /** Why it is not searched, or what is not of it — a sentence for a person. */
  reason?: string;
  /** The package that must be installed for it to be read (`poppler-utils`). Absent from a daemon before it was said. */
  needs?: string;
  sections: number;
  indexedAt: number;
}

/** A section of a document as search sees it: the headings it sits under, the pages, its words. */
export interface KnowledgeSection {
  item: string;
  collection: string;
  path: string;
  n: number;
  trail: string;
  text: string;
  pageFrom?: number;
  pageTo?: number;
}

export interface KnowledgeHit extends KnowledgeSection {
  collectionName: string;
  score: number;
}

export interface RelatedDocument {
  collection: string;
  collectionName: string;
  path: string;
  title: string;
  score: number;
}

/** A file as one upload or a written document saved it: under its own name, and how it reads. */
export interface SavedDocument {
  path: string;
  status: DocumentStatus;
  reason?: string;
}

/** A document an agent saved from a chat into a collection wider than that chat's people: it waits for an admin's yes. */
export interface PendingDocument {
  path: string;
  title: string;
  savedAt: number;
  agent: string;
  /** Who and where, in words: "Gading, in a chat with Nouva". */
  from: string;
  /** The web address it was read from, when it was a page. */
  source?: string;
}

/** What a collection's settings change to: a field left out stays as it is. */
export interface CollectionInput {
  name?: string;
  description?: string;
  readers?: KnowledgeReaders;
  agents?: string[] | null;
  about?: string[];
  archived?: boolean;
}

/** An upload waits for every file to be read, which for a long PDF is a while: far past the client's usual 15 s. */
const UPLOAD_MS = 5 * 60_000;

export const knowledgeApi = {
  knowledge: () => request<{ collections: KnowledgeCollection[] }>(`${control}/knowledge`),
  /** Who may be answered from it, unless an admin says wider: the person who made it. */
  createCollection: (input: CollectionInput & { name: string }) => post<{ collection: KnowledgeCollection | null }>(`${control}/knowledge`, input),
  updateCollection: (id: string, patch: CollectionInput) =>
    request<{ collection: KnowledgeCollection | null }>(`${control}/knowledge/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** An admin's: its documents go with it. */
  deleteCollection: (id: string) => request<{ ok: true }>(`${control}/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),

  knowledgeDocuments: (id: string) => request<{ documents: KnowledgeDocument[] }>(`${control}/knowledge/${encodeURIComponent(id)}/documents`),
  knowledgeDocument: (id: string, path: string) =>
    request<{ document: KnowledgeDocument; sections: KnowledgeSection[] }>(`${control}/knowledge/${encodeURIComponent(id)}/document?path=${encodeURIComponent(path)}`),
  /** Its nearest by meaning; none, with `byMeaning` false, while search by meaning is off. */
  relatedDocuments: (id: string, path: string) =>
    request<{ byMeaning: boolean; related: RelatedDocument[] }>(`${control}/knowledge/${encodeURIComponent(id)}/related?path=${encodeURIComponent(path)}`),
  uploadDocuments: (id: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return request<{ saved: SavedDocument[] }>(`${control}/knowledge/${encodeURIComponent(id)}/documents`, { method: "POST", body: form, timeoutMs: UPLOAD_MS });
  },
  /** A document written on the page, saved under its title. */
  writeDocument: (id: string, title: string, text: string) => post<{ saved: SavedDocument[] }>(`${control}/knowledge/${encodeURIComponent(id)}/documents`, { name: title, text }),
  removeDocument: (id: string, path: string) => request<{ ok: true }>(`${control}/knowledge/${encodeURIComponent(id)}/documents?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  /** A document's title, what search finds it by in any language; null takes it off and its own comes back (0.8.23). */
  setDocumentTitle: (id: string, path: string, title: string | null) =>
    request<{ document: KnowledgeDocument | null }>(`${control}/knowledge/${encodeURIComponent(id)}/documents?path=${encodeURIComponent(path)}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  /** What search finds in every collection: the sections, best first. */
  searchKnowledge: (words: string) => request<{ hits: KnowledgeHit[] }>(`${control}/knowledge/search?q=${encodeURIComponent(words)}`),

  pendingDocuments: (id: string) => request<{ pending: PendingDocument[] }>(`${control}/knowledge/${encodeURIComponent(id)}/pending`),
  /** An admin's: the document joins the collection and is read. */
  approvePending: (id: string, path: string) => post<{ saved: SavedDocument }>(`${control}/knowledge/${encodeURIComponent(id)}/pending/approve`, { path }),
  /** An admin's: the document is deleted. */
  declinePending: (id: string, path: string) => post<{ ok: true }>(`${control}/knowledge/${encodeURIComponent(id)}/pending/decline`, { path }),
};
