/**
 * A document kept from a chat, and a kept file handed back to one: what an agent's `memory_write` (about knowledge)
 * and `send_file` (`document`) do in the knowledge base. Their own file since a file of any kind is kept with a line
 * saying what it is and sent back as it is: `surface.ts` is what the dashboard and the command line read and change.
 */

import { join, statFile } from "@nouride/runtime";
import { readCollections, readersOfConversation, widens, type Collection } from "./collections.ts";
import { addDocument, addPending, collectionIdOf, createCollection, writeNote, writeTitle, type PendingChat } from "./files.ts";
import { parseItem, sectionItem } from "./knowledge.store.ts";
import type { Asker, KnowledgeDeps } from "./surface.ts";

/** What keeping and handing back are done with: the knowledge base, which collections a conversation may use, a sync. */
export interface Keeping {
  knowledge: KnowledgeDeps;
  usable: (asker: Asker) => Collection[];
  sync: (only?: string) => Promise<unknown>;
  now: () => number;
}

/** A document an agent keeps from a chat (`memory_write` about knowledge). */
export interface KeepRequest {
  /** The collection, by its name or id: a new name makes one, for the people in this chat. */
  collection: string;
  /** What the document is: a page's heading, and a file's title kept beside its name. */
  title?: string;
  /** Markdown, written by the agent or read from a page. Beside a `file`, what the file is: the line search finds it by. */
  text?: string;
  /** A file kept as it is: an attachment of the chat, or one in the agent's workspace. */
  file?: { name: string; bytes: Uint8Array };
  /** The web address a page came from. */
  source?: string;
  /** Who and where, in words, for the admin a wider collection asks: "Sam, in a one-to-one chat with nouva". */
  from: string;
  /** The day it is saved, for its frontmatter. */
  day: string;
  /** The chat it was kept from: told the admin's answer when it waits for one. */
  chat?: PendingChat;
}

export type KeepResult =
  | {
      /**
       * `item` is the id search gives it and `send_file` sends its file by; `noted`, that a line about a file was kept
       * with it; `readers` and `inGroups`, who is answered from its collection and whether that goes with them into a
       * group, for the agent to say.
       */
      saved: { collection: string; path: string; status: string; reason?: string; archived?: true; item: string; noted?: true; readers: "everyone" | "admins" | "people" | "group"; inGroups: boolean };
      made: boolean;
    }
  | { waiting: { collection: string; path: string } }
  | { refused: string };

/** A document written from words: its title as a heading unless it has one, its source and day in its frontmatter. */
function asMarkdown(request: Pick<KeepRequest, "title" | "text" | "source" | "day">): string {
  const front = request.source ? `---\nsource: ${request.source}\nsaved: ${request.day}\n---\n` : "";
  const text = (request.text ?? "").trim();
  const heading = /^#\s/.test(text) || !request.title ? "" : `# ${request.title}\n\n`;
  return `${front}${heading}${text}\n`;
}

/**
 * Keep a document from a chat. Into a new collection, made for the people in this chat, or one whose readers are no
 * wider than them: saved at once. Into one wider than that: it waits for an admin's yes. An agent never widens who may
 * be answered from a collection.
 */
export async function keepFromChat(keeping: Keeping, asker: Asker, request: KeepRequest): Promise<KeepResult> {
  const { knowledge, now } = keeping;
  const name = request.collection.trim();
  if (!name) return { refused: "Name the collection to keep it in." };
  const id = collectionIdOf(name);
  const known = readCollections(knowledge.root).find((collection) => collection.id === id || collection.settings.name.toLowerCase() === name.toLowerCase());
  const file = request.file ?? (request.text?.trim() ? { name: `${(request.title ?? "Note").replace(/[\\/]/g, "-")}.md`, bytes: new TextEncoder().encode(asMarkdown(request)) } : null);
  if (!file) return { refused: "Give the document's text, or a file." };
  const forChat = readersOfConversation(asker.audience);
  let made = false;
  let target = known;
  if (!target) {
    const created = await createCollection(knowledge.root, id, { name, description: "", agents: null, readers: forChat, about: [], archived: false });
    if ("refused" in created) return created;
    target = created;
    made = true;
  } else if (widens(target.settings.readers, forChat, knowledge.admins())) {
    const waiting = await addPending(knowledge.root, target.id, file.name, file.bytes, {
      title: request.title ?? file.name,
      savedAt: now(),
      agent: asker.agentId,
      from: request.from,
      ...(request.source ? { source: request.source } : {}),
      ...(request.chat ? { chat: request.chat } : {}),
    });
    return "refused" in waiting ? waiting : { waiting: { collection: target.settings.name, path: waiting.path } };
  }
  const added = await addDocument(knowledge.root, target.id, file.name, file.bytes);
  if ("refused" in added) return added;
  // A file keeps its name, and its title beside it: what search finds it by. A page has its title as its heading,
  // unless its text came with a heading of its own: then the title goes beside it too.
  if (request.title && (request.file || /^#\s/.test((request.text ?? "").trim()))) {
    const titled = await writeTitle(knowledge.root, target.id, added.path, request.title);
    if ("refused" in titled) return titled;
  }
  // What a file is, said by the agent that was shown it: a picture has no words of its own to be found by.
  const note = request.file ? (request.text ?? "").trim() : "";
  if (note) {
    const noted = await writeNote(knowledge.root, target.id, added.path, note);
    if ("refused" in noted) return noted;
  }
  await keeping.sync(target.id);
  const document = knowledge.store.document(target.id, added.path);
  return {
    saved: {
      collection: target.settings.name,
      path: added.path,
      status: document?.status ?? "indexed",
      ...(document?.reason ? { reason: document.reason } : {}),
      ...(target.settings.archived ? { archived: true } : {}),
      item: sectionItem(target.id, added.path, 0),
      ...(note ? { noted: true as const } : {}),
      readers: target.settings.readers.kind,
      inGroups: target.settings.inGroups ?? asker.brings ?? true,
    },
    made,
  };
}

/**
 * A kept document's own file, for an agent to send into the chat it is asked from: by the id search gave one of its
 * sections, and only from a collection this conversation may be answered from. The knowledge folder is not one an
 * agent's file tools reach, so a file kept there could be found and never handed back; and opening the folder to
 * them would pass over each collection's readers, which this asks first.
 */
export function keptFile(keeping: Pick<Keeping, "knowledge" | "usable">, asker: Asker, item: string): { path: string; name: string; title: string } | { refused: string } {
  const parsed = parseItem(item);
  const { knowledge } = keeping;
  const nothing = { refused: `no document "${item}" that this chat may read` };
  if (!parsed) return nothing;
  const collection = keeping.usable(asker).find((candidate) => candidate.id === parsed.collection);
  const document = collection ? knowledge.store.document(parsed.collection, parsed.path) : null;
  if (!collection || !document) return nothing;
  const path = join(collection.dir, ...document.path.split("/"));
  if (!statFile(path)) return { refused: `"${document.title}" is no longer in "${collection.settings.name}": its file is gone.` };
  return { path, name: document.path.split("/").at(-1)!, title: document.title };
}
