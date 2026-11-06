/**
 * Editing the arrays of tables in a config file: `[[servers]]` in the MCP library (`agents/mcp.toml`), `[[people]]` in
 * the daemon's `config.toml`.
 *
 * Each block is found by what identifies it — a server by its `name`, a person by their `key` or an account they hold —
 * read with the real parser, so `name = 'search'` and an `ids` array over several lines are what they are. A block is
 * patched, never rebuilt: the keys an edit owns are written or removed and every other line of it, a key this editor
 * does not know or a comment, stays as written. Built on the same reading and the same check as `edit.ts`.
 */

import { canonicalPersonId } from "@/modules/people/match.ts";
import { checked, type Parsed } from "./edit-check.ts";
import { appendBlock, apply, collapseBlankRuns, dropLines, insertAfter, renderKey, renderValue, replaceValue, type Splice } from "./edit.ts";
import { readToml, samePath, valueOf, type TomlDocument, type TomlEntry, type TomlHeader } from "./toml-lines.ts";

/** One element of an array of tables: its header, its lines up to its last value — sub-tables included — and its values. */
interface Element {
  header: TomlHeader;
  index: number;
  /** The last line that is its: its last value, or its header. */
  last: number;
  entries: TomlEntry[];
}

function elementsOf(doc: TomlDocument, array: string): Element[] {
  const elements: Element[] = [];
  for (const header of doc.headers) {
    if (!header.array || !samePath(header.path, [array])) continue;
    const index = header.element!;
    const mine = doc.entries.filter((entry) => entry.element === index && entry.table[0] === array);
    const subHeaders = doc.headers.filter((other) => !other.array && other.element === index && other.path[0] === array);
    const last = Math.max(header.line, ...mine.map((entry) => entry.end), ...subHeaders.map((other) => other.line));
    elements.push({ header, index, last, entries: mine });
  }
  return elements;
}

/** An element's own value for `key` — not a sub-table's. */
function own(element: Element, key: string): TomlEntry | undefined {
  return element.entries.find((entry) => entry.table.length === 1 && samePath(entry.key, [key]));
}

function ownValue(doc: TomlDocument, element: Element, key: string): unknown {
  const entry = own(element, key);
  return entry ? valueOf(doc, entry) : undefined;
}

/** An element taken out of a parsed array of tables — and the array with it when it was the last: no header, no key. */
function withoutElement(parsed: Parsed, array: string, index: number): void {
  const list = parsed[array] as Parsed[];
  list.splice(index, 1);
  if (list.length === 0) delete parsed[array];
}

/** The element removed, up to its last line; the blank lines after it go with it. */
function removeElement(doc: TomlDocument, element: Element): string {
  return collapseBlankRuns(apply(doc.text, [dropLines(doc, element.header.line, element.last)]));
}

/**
 * An element patched: `set` written where the key is or added under its last value, `drop` removed, every other line
 * — a key this editor does not know, a comment — left as written.
 */
function patchElement(doc: TomlDocument, element: Element, set: [string, unknown][], drop: string[]): Splice[] {
  const splices: Splice[] = [];
  const missing: string[] = [];
  for (const [key, value] of set) {
    const entry = own(element, key);
    if (entry) splices.push(replaceValue(entry, value));
    else missing.push(`${renderKey(key)} = ${renderValue(value)}`);
  }
  for (const key of drop) {
    const entry = own(element, key);
    if (entry) splices.push(dropLines(doc, entry.start, entry.end));
  }
  if (missing.length > 0) {
    const ownEntries = element.entries.filter((entry) => entry.table.length === 1);
    splices.push(insertAfter(doc, ownEntries.at(-1)?.end ?? element.header.line, missing));
  }
  return splices;
}

// ── MCP servers ─────────────────────────────────────────────────────────────

export interface McpServerEdit {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** The secret's **name**. The value never comes through here — see `McpServerConfig.authSecret`. */
  authSecret?: string;
  authHeader?: string;
  /** Variable → secret **name** (`McpServerConfig.envSecrets`). Written when sent, the table removed when sent empty. */
  envSecrets?: Record<string, string>;
  /** The library's `per_agent` (`McpServerConfig.perAgent`): written when true, removed when sent false. */
  perAgent?: boolean;
  /** Written only when sent — the form shows none — so a block's own stays (`McpServerConfig.parallelSafe`). */
  parallelSafe?: boolean | string[];
}


/** The keys the server form owns: written when it sends them, removed when it does not. */
function ownedKeys(server: McpServerEdit): { set: [string, unknown][]; drop: string[] } {
  const fields: [string, unknown][] = [
    ["name", server.name],
    ["transport", server.transport],
    ["command", server.command || undefined],
    ["args", server.args?.length ? server.args : undefined],
    ["cwd", server.cwd || undefined],
    ["url", server.url || undefined],
    ["auth_secret", server.authSecret || undefined],
    ["auth_header", server.authHeader || undefined],
  ];
  const perAgent: [string, unknown][] = server.perAgent === undefined ? [] : [["per_agent", server.perAgent || undefined]];
  // `env` and `headers` only when sent: the form shows neither, and a save from it must not take away what was
  // written by hand — a stdio server's env, an http server's headers.
  const extra: [string, unknown][] = [
    ["env", server.env && Object.keys(server.env).length ? server.env : undefined],
    ["headers", server.headers && Object.keys(server.headers).length ? server.headers : undefined],
    ["parallel_safe", server.parallelSafe],
  ];
  // The form does own these when it sends them: the whole set it shows, so one taken off is gone from the file.
  const secretEnv = server.envSecrets;
  const owned: [string, unknown][] = secretEnv === undefined ? [] : [["env_secrets", Object.keys(secretEnv).length ? secretEnv : undefined]];
  return {
    set: [...fields, ...extra, ...owned, ...perAgent].filter((field): field is [string, unknown] => field[1] !== undefined),
    drop: [...fields, ...owned, ...perAgent].filter(([, value]) => value === undefined).map(([key]) => key),
  };
}

/**
 * Add a server, or patch the one with this name: the keys the form owns are written or removed, and the rest of its
 * block — `parallel_safe`, `enabled`, a comment, a key a later release adds — stays as it was. Rebuilding the block from
 * the form dropped all of those, and a URL change made its tools run one at a time again.
 */
export function upsertMcpServer(source: string, server: McpServerEdit): string {
  const array = "servers";
  const doc = readToml(source);
  const existing = elementsOf(doc, array).find((element) => ownValue(doc, element, "name") === server.name);
  const { set, drop } = ownedKeys(server);
  if (!existing) {
    const block = [`[[${array}]]`, ...set.map(([key, value]) => `${renderKey(key)} = ${renderValue(value)}`)];
    return checked(source, appendBlock(source, block), `MCP server "${server.name}"`, (parsed) => {
      parsed[array] = [...((parsed[array] as Parsed[] | undefined) ?? []), Object.fromEntries(set)];
    });
  }
  const after = apply(doc.text, patchElement(doc, existing, set, drop));
  return checked(source, after, `MCP server "${server.name}"`, (parsed) => {
    const element = (parsed[array] as Parsed[])[existing.index]!;
    for (const [key, value] of set) element[key] = value;
    for (const key of drop) delete element[key];
  });
}

/** Remove the server with this name. Unknown names are left alone rather than reported. */
export function removeMcpServer(source: string, name: string): string {
  const array = "servers";
  const doc = readToml(source);
  const existing = elementsOf(doc, array).find((element) => ownValue(doc, element, "name") === name);
  if (!existing) return source;
  return checked(source, removeElement(doc, existing), `MCP server "${name}"`, (parsed) => withoutElement(parsed, array, existing.index));
}

// ── People ──────────────────────────────────────────────────────────────────

interface PersonBlock extends Element {
  /** The person, when the block says; a block written by hand without one does not. */
  key: string | null;
  ids: string[];
}

/**
 * Every `[[people]]` block, with its key and the accounts it claims — read with the real parser, so `key = 'ann'` and
 * an `ids` array over several lines, with comments in it, are what they are.
 */
function peopleBlocks(doc: TomlDocument): PersonBlock[] {
  return elementsOf(doc, "people").map((element) => {
    const key = ownValue(doc, element, "key");
    const ids = ownValue(doc, element, "ids");
    return {
      ...element,
      key: typeof key === "string" ? key : null,
      ids: Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string") : [],
    };
  });
}

/**
 * Does this block speak for `id`? By the platform's spelling, so a sender as a connection saw it finds the person. The
 * block's own ids are taken as written: one that names its connection is a form the loader refuses, not one to match.
 */
function blockClaims(block: Pick<PersonBlock, "ids">, id: string): boolean {
  const wanted = canonicalPersonId(id);
  return block.ids.includes(wanted);
}

/**
 * This person's block: by key, or — one hand-written without a key — by an account it claims.
 *
 * Both are needed, and in that order. The key is the person; but a block a person hand-wrote without one is still
 * theirs, and appending a second block for them would be two people with one account, which the validator warns
 * about and the matcher resolves to whichever comes first.
 */
function blockOf(blocks: PersonBlock[], person: { key: string; ids?: string[] }, accounts: readonly string[] = []): PersonBlock | undefined {
  return (
    blocks.find((block) => block.key === person.key) ??
    blocks.find((block) => block.key === null && [...(person.ids ?? []), ...accounts].some((id) => blockClaims(block, id)))
  );
}

/**
 * Write one person: their block found and patched, or added.
 *
 * `name` and `key` are set. `notes`, `ids` and `facts` follow three cases, and the middle one is the one that matters:
 * a value sets it; **`undefined` leaves whatever is there** — `nouride people set <account> --name X` says nothing about
 * notes, and an agent recording somebody's name must not silently delete what the operator wrote about them; `""` (or
 * `[]`) removes the line.
 *
 * Patched, never rebuilt: rebuilding from the fields at hand deleted every address a person held but the one being
 * written, and every comment in their block.
 */
export function upsertPerson(
  source: string,
  /** `facts` "" and `recall` null drop the key: the person follows `[memory]` again. `morning` "" drops their line, `morningTo` "" where it goes. */
  person: { key: string; name: string; notes?: string; ids?: string[]; facts?: string; recall?: boolean | null; morning?: string; morningTo?: string },
  /** The accounts they held before this write, for finding a block hand-written without a key. */
  accounts: readonly string[] = [],
): string {
  const doc = readToml(source);
  const existing = blockOf(peopleBlocks(doc), person, accounts);

  if (!existing) {
    // The key first, then the name: who this is, what to call them, then where they are reachable.
    const fields: [string, unknown][] = [
      ["key", person.key],
      ["name", person.name],
      ["ids", person.ids?.length ? person.ids : undefined],
      ["notes", person.notes || undefined],
      ["facts", person.facts || undefined],
      ["recall", person.recall ?? undefined],
      ["morning", person.morning || undefined],
      ["morning_to", person.morningTo || undefined],
    ];
    const written = fields.filter((field): field is [string, unknown] => field[1] !== undefined);
    const block = ["[[people]]", ...written.map(([key, value]) => `${key} = ${renderValue(value)}`)];
    return checked(source, appendBlock(source, block), `[[people]] ${person.key}`, (parsed) => {
      parsed.people = [...((parsed.people as Parsed[] | undefined) ?? []), Object.fromEntries(written)];
    });
  }

  const ids = person.ids;
  const set: [string, unknown][] = [["name", person.name]];
  const drop: string[] = [];
  const optional: [string, string | string[] | undefined][] = [
    ["ids", ids],
    ["notes", person.notes],
    ["facts", person.facts],
    ["morning", person.morning],
    ["morning_to", person.morningTo],
  ];
  for (const [key, value] of optional) {
    if (value === undefined) continue;
    if (value.length === 0) drop.push(key);
    else set.push([key, value]);
  }
  if (person.recall === null) drop.push("recall");
  else if (person.recall !== undefined) set.push(["recall", person.recall]);

  const splices: Splice[] = [];
  // A key the block did not have goes first, under its header: who this is, before anything else.
  const keyEntry = own(existing, "key");
  if (keyEntry) splices.push(replaceValue(keyEntry, person.key));
  else splices.push(insertAfter(doc, existing.header.line, [`key = ${renderValue(person.key)}`]));
  splices.push(...patchElement(doc, existing, set, drop));

  return checked(source, apply(doc.text, splices), `[[people]] ${person.key}`, (parsed) => {
    const element = (parsed.people as Parsed[])[existing.index]!;
    element.key = person.key;
    for (const [key, value] of set) element[key] = value;
    for (const key of drop) delete element[key];
  });
}

/** This person's block removed: found by key, or by an account for a block written before keys existed. */
export function removePerson(source: string, person: { key: string; ids?: string[] }): string {
  const doc = readToml(source);
  const existing = blockOf(peopleBlocks(doc), person);
  if (!existing) return source;
  return checked(source, removeElement(doc, existing), `[[people]] ${person.key}`, (parsed) => withoutElement(parsed, "people", existing.index));
}

/**
 * Write the keys a file's blocks do not have yet, by position.
 *
 * `readPeople` gave every entry written without a key one from its name, in file order; this puts those keys into the
 * same blocks, so they stop depending on the order and the names. By position rather than by account, because a
 * person added by name has no account to find their block by. A file whose blocks do not line up with `keys` — edited
 * since it was read — is returned unchanged.
 */
export function addMissingPeopleKeys(source: string, keys: readonly string[]): string {
  const doc = readToml(source);
  const blocks = peopleBlocks(doc);
  if (blocks.length !== keys.length) return source;
  const missing = blocks.filter((block) => block.key === null);
  if (missing.length === 0) return source;
  const after = apply(doc.text, missing.map((block) => insertAfter(doc, block.header.line, [`key = ${renderValue(keys[block.index]!)}`])));
  return checked(source, after, "[[people]] keys", (parsed) => {
    for (const block of missing) (parsed.people as Parsed[])[block.index]!.key = keys[block.index]!;
  });
}
