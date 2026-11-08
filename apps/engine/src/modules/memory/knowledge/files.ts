/**
 * Changing the knowledge folder: a collection made, its settings written, a document added or removed (KNOWLEDGE_BASE
 * §9 and §11, 0.8.20). The dashboard, the command line and an agent's `memory_write` all come through here, so a name
 * that would walk out of the folder, or over a file already there, is refused or renamed in one place.
 *
 * The index follows the folder (`sync.ts`): each change here is followed by a sync of its collection by the caller.
 */

import { dirExists, ensureDir, join, listDir, readTextFileSync, removePath, renamePath, statFile, writeFileAtomic, writeTextFileAtomic } from "@nouride/runtime";
import { isCollectionId, readCollection, renderSettings, SETTINGS_FILE, type Collection, type CollectionSettings } from "./collections.ts";

/**
 * Why a change to the knowledge folder was refused (0.8.20). `refused` is said to an agent and the command line; the
 * dashboard's words are worded at its route from `why`, never read out of that sentence.
 */
export type KnowledgeRefusal = { refused: string; why: "name" | "taken" | "missing" };

/** A collection's id from its name: lowercase words joined by `-`, what a folder can be called anywhere. */
export function collectionIdOf(name: string): string {
  const id = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return id || "collection";
}

/**
 * A document's file name as given, made safe: no folder in it, nothing hidden, at most a sensible length. An upload's
 * name is the person's; the folder must never take it as a path.
 */
function documentNameOf(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop()!.trim().replace(/[\u0000-\u001f]/g, "");
  if (!base || base === "." || base === ".." || base.startsWith(".")) return null;
  if (base === SETTINGS_FILE) return null;
  return base.length > 120 ? `${base.slice(0, 100)}${base.slice(base.lastIndexOf("."))}` : base;
}

/** `name.ext`, else `name (2).ext`, … : free in every one of `dirs`, so a document never overwrites another by its name. */
function freeName(dirs: string | readonly string[], name: string): string {
  const taken = (candidate: string) => (typeof dirs === "string" ? [dirs] : dirs).some((dir) => statFile(join(dir, candidate)));
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

export async function createCollection(root: string, id: string, settings: CollectionSettings): Promise<Collection | KnowledgeRefusal> {
  if (!isCollectionId(id)) return { refused: `"${id}" cannot be a collection's name: use letters, digits, spaces, "." "-" or "_".`, why: "name" };
  const dir = join(root, id);
  if (dirExists(dir)) return { refused: `There is already a collection called "${id}".`, why: "taken" };
  ensureDir(dir);
  await writeTextFileAtomic(join(dir, SETTINGS_FILE), renderSettings(settings));
  return readCollection(root, id);
}

export async function writeSettings(root: string, id: string, settings: CollectionSettings): Promise<Collection | KnowledgeRefusal> {
  if (!isCollectionId(id) || !dirExists(join(root, id))) return { refused: `There is no collection called "${id}".`, why: "missing" };
  await writeTextFileAtomic(join(root, id, SETTINGS_FILE), renderSettings(settings));
  return readCollection(root, id);
}

/** A document's bytes into a collection, under a name of its own there. The path it was saved at, relative to the collection. */
export async function addDocument(root: string, id: string, name: string, bytes: Uint8Array): Promise<{ path: string } | KnowledgeRefusal> {
  if (!isCollectionId(id) || !dirExists(join(root, id))) return { refused: `There is no collection called "${id}".`, why: "missing" };
  const safe = documentNameOf(name);
  if (!safe) return { refused: `"${name}" cannot be a document's name.`, why: "name" };
  const path = freeName(join(root, id), safe);
  await writeFileAtomic(join(root, id, path), bytes);
  return { path };
}

/**
 * A document's title written beside its file's name in the collection's `knowledge.toml` (0.8.23), or taken off with
 * null. The file is never renamed: it keeps the name it came with, and the title is what search finds it by.
 */
export async function writeTitle(root: string, id: string, path: string, title: string | null): Promise<Collection | KnowledgeRefusal> {
  if (!isCollectionId(id) || !dirExists(join(root, id))) return { refused: `There is no collection called "${id}".`, why: "missing" };
  if (path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return { refused: `"${path}" is not a document's path.`, why: "name" };
  if (title !== null && !statFile(join(root, id, path))) return { refused: `There is no document "${path}" in "${id}".`, why: "missing" };
  const { settings } = readCollection(root, id);
  const titles = { ...settings.titles };
  if (title === null) delete titles[path];
  else titles[path] = title;
  return await writeSettings(root, id, { ...settings, titles });
}

/** A document's file, by its path in the collection; false when there was none. A path out of the collection is never one. */
export function removeDocument(root: string, id: string, path: string): boolean {
  if (!isCollectionId(id) || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  const full = join(root, id, path);
  if (!statFile(full)) return false;
  removePath(full);
  return true;
}

/** A collection's folder, its documents with it. False when there was none. */
export function removeCollection(root: string, id: string): boolean {
  if (!isCollectionId(id) || !dirExists(join(root, id))) return false;
  removePath(join(root, id));
  return true;
}

/**
 * Documents an agent saved from a chat into a collection wider than that chat (§9), waiting for an admin's yes: in the
 * collection's hidden `.pending/` folder, which the index never reads, each with what it is and where it came from.
 */
const PENDING = ".pending";

/** The chat a document was kept from, to be told the admin's answer (0.8.23). */
export interface PendingChat {
  agentId: string;
  gatewayId: string;
  chatId: string;
  chatType: "dm" | "group" | "channel";
}

export interface PendingDocument {
  path: string;
  title: string;
  savedAt: number;
  agent: string;
  /** Who and where, in words: "Gading, in a chat with Nouva". */
  from: string;
  source?: string;
  /** Absent on what waited from before 0.8.23: nobody is told of its answer. */
  chat?: PendingChat;
}

const isChat = (value: unknown): value is PendingChat =>
  typeof value === "object" && value !== null && ["agentId", "gatewayId", "chatId"].every((key) => typeof (value as Record<string, unknown>)[key] === "string") &&
  ["dm", "group", "channel"].includes((value as PendingChat).chatType);

const isPending = (value: unknown): value is Omit<PendingDocument, "path"> =>
  typeof value === "object" && value !== null && typeof (value as PendingDocument).title === "string" && typeof (value as PendingDocument).savedAt === "number" &&
  typeof (value as PendingDocument).agent === "string" && typeof (value as PendingDocument).from === "string" &&
  ((value as PendingDocument).chat === undefined || isChat((value as PendingDocument).chat));

export async function addPending(root: string, id: string, name: string, bytes: Uint8Array, about: Omit<PendingDocument, "path">): Promise<{ path: string } | KnowledgeRefusal> {
  if (!isCollectionId(id) || !dirExists(join(root, id))) return { refused: `There is no collection called "${id}".`, why: "missing" };
  const safe = documentNameOf(name);
  if (!safe) return { refused: `"${name}" cannot be a document's name.`, why: "name" };
  const dir = join(root, id, PENDING);
  ensureDir(dir);
  // Free in what waits and in the collection: approved, it must not land on a document already there.
  const path = freeName([dir, join(root, id)], safe);
  await writeFileAtomic(join(dir, path), bytes);
  await writeTextFileAtomic(join(dir, `${path}.why.json`), JSON.stringify(about));
  return { path };
}

export function pendingOf(root: string, id: string): PendingDocument[] {
  const dir = join(root, id, PENDING);
  if (!isCollectionId(id) || !dirExists(dir)) return [];
  return listDir(dir)
    .filter((entry) => entry.isFile && !entry.name.endsWith(".why.json"))
    .flatMap((entry) => {
      const why = statFile(join(dir, `${entry.name}.why.json`)) ? (JSON.parse(readTextFileSync(join(dir, `${entry.name}.why.json`))) as unknown) : null;
      return isPending(why) ? [{ path: entry.name, ...why }] : [];
    })
    .sort((a, b) => a.savedAt - b.savedAt);
}

/** An admin's yes: the document joins the collection under a name of its own there. Its path, or null when none waits. */
export function approvePending(root: string, id: string, path: string): string | null {
  const dir = join(root, id, PENDING);
  if (!isCollectionId(id) || path.includes("/") || path.startsWith(".") || !statFile(join(dir, path))) return null;
  const target = freeName(join(root, id), path);
  renamePath(join(dir, path), join(root, id, target));
  removePath(join(dir, `${path}.why.json`));
  return target;
}

/** An admin's no: the document is deleted. */
export function declinePending(root: string, id: string, path: string): boolean {
  const dir = join(root, id, PENDING);
  if (!isCollectionId(id) || path.includes("/") || path.startsWith(".") || !statFile(join(dir, path))) return false;
  removePath(join(dir, path));
  removePath(join(dir, `${path}.why.json`));
  return true;
}
