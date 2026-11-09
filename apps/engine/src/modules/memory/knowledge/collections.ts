/**
 * The knowledge base's collections: a folder each under `.nouride/knowledge/`, and who may be answered from one.
 *
 * A collection's settings are its `knowledge.toml`, every key optional, which the dashboard writes. Who may be answered
 * from it is closed until opened, by where it came from: the dashboard writes the person who made it, a chat writes the
 * people in that chat, and a folder made by hand, with no `readers`, is the admins'. Decided here, in code, from who is
 * in the conversation: the rule memory's facts keep (`access.ts`), never a model's call.
 *
 * Pure but for reading the folders.
 */

import { join, listDir, parseToml, readTextFileSync, statFile } from "@nouride/runtime";
import type { Audience } from "../access.ts";

/** The settings file in a collection's folder. */
export const SETTINGS_FILE = "knowledge.toml";

/** Who may be answered from a collection. */
export type KnowledgeReaders =
  | { kind: "everyone" }
  /** The people whose dashboard account is an admin's: a folder made by hand says nothing, and is theirs. */
  | { kind: "admins" }
  | { kind: "people"; people: readonly string[] }
  /** One group chat, by memory's key for it (`memoryChatKey`). */
  | { kind: "group"; chat: string };

export interface CollectionSettings {
  name: string;
  /** One line for the agent's prompt, saying when to look in it. */
  description: string;
  /** The agents that search it; null is every agent. */
  agents: readonly string[] | null;
  readers: KnowledgeReaders;
  /** Whom it is about, by person key. It grants nothing. */
  about: readonly string[];
  /** Kept, never searched. */
  archived: boolean;
  /**
   * A document's title by its path, kept beside its file's name (0.8.23): what search finds it by in any language. An
   * agent gives an English one when it keeps a document; a person sets one on the dashboard. Absent, a document's title
   * is its first heading or its file's name.
   */
  titles?: Readonly<Record<string, string>>;
}

/** A title's length at most: a line naming a document, not its summary. */
export const TITLE_MAX = 200;

export interface Collection {
  /** The folder's name: the collection's id in every item and route. */
  id: string;
  dir: string;
  settings: CollectionSettings;
  /** What in its `knowledge.toml` could not be read, said once where the collection is shown; its defaults stand. */
  problem?: string;
}

/** A collection id: a folder name a person can type, never one that walks out of the knowledge folder. */
export function isCollectionId(id: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(id) && !id.includes("..");
}

/** Readers as `knowledge.toml` writes them: `"everyone"`, `"admins"`, `"group:<chat key>"`, or a list of person keys. */
function readersFrom(value: unknown): KnowledgeReaders | { problem: string } {
  if (value === undefined) return { kind: "admins" };
  if (value === "everyone") return { kind: "everyone" };
  if (value === "admins") return { kind: "admins" };
  if (typeof value === "string" && value.startsWith("group:") && value.length > "group:".length) return { kind: "group", chat: value.slice("group:".length) };
  if (Array.isArray(value) && value.every((key) => typeof key === "string" && key.trim())) return { kind: "people", people: value.map((key) => key.trim()) };
  return { problem: `readers is ${JSON.stringify(value)}: write "everyone", "admins", "group:<chat>", or a list of people's keys` };
}

function readersToml(readers: KnowledgeReaders): string {
  switch (readers.kind) {
    case "everyone":
    case "admins":
      return JSON.stringify(readers.kind);
    case "group":
      return JSON.stringify(`group:${readers.chat}`);
    case "people":
      return JSON.stringify(readers.people);
  }
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null);

/** A collection's settings from its `knowledge.toml`, and what of it could not be read. Unset keys take their defaults. */
export function parseSettings(id: string, source: string | null): { settings: CollectionSettings; problem?: string } {
  const defaults: CollectionSettings = { name: id, description: "", agents: null, readers: { kind: "admins" }, about: [], archived: false };
  if (source === null) return { settings: defaults };
  let raw: Record<string, unknown>;
  try {
    raw = parseToml<Record<string, unknown>>(source);
  } catch (err) {
    // Unreadable is closed: the admins', as a folder with no file is, until the file is fixed.
    return { settings: defaults, problem: `${SETTINGS_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const problems: string[] = [];
  const readers = readersFrom(raw.readers);
  if ("problem" in readers) problems.push(readers.problem);
  const agents = raw.agents === undefined ? null : strings(raw.agents);
  if (raw.agents !== undefined && !agents) problems.push("agents is not a list of agent ids");
  const about = raw.about === undefined ? [] : strings(raw.about);
  if (raw.about !== undefined && !about) problems.push("about is not a list of people's keys");
  const titles = raw.titles === undefined ? {} : titlesFrom(raw.titles);
  if (!titles) problems.push("titles is not a table of file names and their titles");
  const settings: CollectionSettings = {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    agents: agents ?? null,
    readers: "problem" in readers ? { kind: "admins" } : readers,
    about: about ?? [],
    archived: raw.archived === true,
    titles: titles ?? {},
  };
  return problems.length ? { settings, problem: problems.join("; ") } : { settings };
}

/** `[titles]` as written: each a file's path and a line naming it. One that is not is dropped, and the rest kept. */
function titlesFrom(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const titles: Record<string, string> = {};
  for (const [path, title] of Object.entries(value)) {
    if (typeof title === "string" && title.trim() && path.trim()) titles[path] = title.trim().slice(0, TITLE_MAX);
  }
  return titles;
}

/** `knowledge.toml` as the dashboard writes it: every key that says something, the default ones left out. */
export function renderSettings(settings: CollectionSettings): string {
  const lines = [`name = ${JSON.stringify(settings.name)}`];
  if (settings.description) lines.push(`description = ${JSON.stringify(settings.description)}`);
  if (settings.agents) lines.push(`agents = ${JSON.stringify(settings.agents)}`);
  lines.push(`readers = ${readersToml(settings.readers)}`);
  if (settings.about.length) lines.push(`about = ${JSON.stringify(settings.about)}`);
  if (settings.archived) lines.push("archived = true");
  // A table comes after the keys in TOML: the titles last, by path, so the file reads the same each time it is written.
  const titles = Object.entries(settings.titles ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (titles.length) lines.push("", "[titles]", ...titles.map(([path, title]) => `${JSON.stringify(path)} = ${JSON.stringify(title)}`));
  return `${lines.join("\n")}\n`;
}

/** The collections under the knowledge folder, by name. A folder that is not a collection id is left alone. */
export function readCollections(root: string): Collection[] {
  if (!statFile(root)?.isDirectory) return [];
  return listDir(root)
    .filter((entry) => entry.isDirectory && isCollectionId(entry.name))
    .map((entry) => readCollection(root, entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readCollection(root: string, id: string): Collection {
  const dir = join(root, id);
  const file = join(dir, SETTINGS_FILE);
  const source = statFile(file) ? readTextFileSync(file) : null;
  const { settings, problem } = parseSettings(id, source);
  return { id, dir, settings, ...(problem ? { problem } : {}) };
}

/**
 * Whether this agent may search this collection in this conversation.
 *
 * Every person in the conversation must be a reader. In a group that is known only of the group itself, so a group is
 * answered from `everyone`'s collections and its own; a collection of named people, the admins' included, is a
 * one-to-one chat's. A private collection is never searched in a group, even one its reader is in.
 */
export function mayUse(collection: Pick<Collection, "settings">, who: { agentId: string; audience: Audience; admins: readonly string[] }): boolean {
  const { settings } = collection;
  if (settings.archived) return false;
  if (settings.agents && !settings.agents.includes(who.agentId)) return false;
  const { readers } = settings;
  switch (readers.kind) {
    case "everyone":
      return true;
    case "group":
      return who.audience.kind === "group" && who.audience.chat === readers.chat;
    case "admins":
      return who.audience.kind === "dm" && who.admins.includes(who.audience.person);
    case "people":
      return who.audience.kind === "dm" && readers.people.includes(who.audience.person);
  }
}

/** Who a collection made from this conversation is for: its one person, or its group. */
export function readersOfConversation(audience: Audience): KnowledgeReaders {
  return audience.kind === "dm" ? { kind: "people", people: [audience.person] } : { kind: "group", chat: audience.chat };
}

/**
 * Whether `wider` reaches someone `narrower` does not: saving there from a chat waits for an admin's yes. `narrower`
 * is a chat's readers, its person or its group. The admins are the people they are: a folder made by hand is the one
 * admin's own when there is one admin, and saving into it from their chat is not widening it.
 */
export function widens(wider: KnowledgeReaders, narrower: KnowledgeReaders, admins: readonly string[] = []): boolean {
  const reach = wider.kind === "admins" ? ({ kind: "people", people: admins } as const) : wider;
  if (reach.kind === "people" && narrower.kind === "people") return reach.people.some((person) => !narrower.people.includes(person));
  if (reach.kind === "group" && narrower.kind === "group") return reach.chat !== narrower.chat;
  return true;
}
