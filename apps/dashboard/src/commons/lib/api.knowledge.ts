/**
 * The knowledge base's calls (0.8.20, KNOWLEDGE_BASE §11): its collections, their documents, what search finds in them,
 * and the documents an agent saved from a chat that wait for an admin's yes. Spread into `api` like the other menus'.
 * The types are the engine's (`routes/knowledge.ts`), written again: the dashboard is its own build.
 */

import { control, post, request } from "./api.client";
import type { CollectionInput, KnowledgeCollection, KnowledgeDocument, KnowledgeHit, KnowledgeSection, PendingDocument, RelatedDocument, SavedDocument } from "@nouride/wire";

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
