/**
 * The knowledge base (`routes/knowledge.ts`): its collections, their documents, and what search finds in them.
 */

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
