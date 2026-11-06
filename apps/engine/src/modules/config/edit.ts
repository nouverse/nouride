/**
 * Changing a `config.toml` without rewriting the file.
 *
 * The dashboard has to write a provider profile and an orchestrator into a file the operator may have
 * hand-edited, and `config.example.toml` is nine parts comment to one part setting — the comments *are*
 * the documentation for this daemon. Parsing to an object and serialising back would delete all of it
 * and reorder the rest, and the operator would find that out by opening the file weeks later.
 *
 * So this edits text, on one reading of it (`toml-lines.ts`): the tables and every key's value, found the way TOML
 * finds them — a literal string, a value over several lines, a quoted header, a table written as dotted keys or as an
 * inline table in its parent. An edit replaces a value's span and keeps the comment after it, adds a key under its
 * table's last one rather than under the next section's banner, and leaves every other byte alone.
 *
 * And every edit is checked against the file's own meaning: parsed before and after, the result has to be exactly
 * what was there with the one change made (`checked`). A shape this reading gets wrong is a refusal — the editor
 * cannot change that safely, edit it by hand — never a file that quietly says something else.
 */

import { checked, tableAt, type Parsed } from "./edit-check.ts";
import { readToml, samePath, valueOf, type TomlDocument, type TomlEntry, type TomlHeader } from "./toml-lines.ts";

/**
 * What a setting can be written as: a string, a number, a boolean, or a list of strings — `[skills] off` is one, and
 * a setting the dashboard toggles has to be writable by the thing that toggles it.
 */
export type TomlScalar = string | number | boolean | string[];

/** And a flat table of strings, for an MCP server's `env` and `headers` — or a list of them, an agent's `fallbacks`. */
type TomlValue = TomlScalar | Record<string, string> | Record<string, string>[];

// ── Rendering ───────────────────────────────────────────────────────────────

/** TOML basic strings escape the same characters JSON does, and `JSON.stringify` is exact for them. */
export function renderValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(renderValue).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} to TOML`);
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${renderKey(k)} = ${renderValue(v)}`).join(", ")} }`;
  }
  throw new Error(`cannot write ${String(value)} to TOML`);
}

/** Bare where TOML allows it; quoted otherwise — a header name with a hyphen in it is fine, one with a dot is not. */
export function renderKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

// ── Text edits ──────────────────────────────────────────────────────────────

/** A span of the text replaced: offsets into the document's text. */
export interface Splice {
  from: number;
  to: number;
  text: string;
}

function lineStart(doc: TomlDocument, line: number): number {
  let offset = 0;
  for (let index = 0; index < line && index < doc.lines.length; index += 1) offset += doc.lines[index]!.length + 1;
  return Math.min(offset, doc.text.length);
}

/** Lines `[from, to]` taken out whole, newline and all. */
export function dropLines(doc: TomlDocument, from: number, to: number): Splice {
  return { from: lineStart(doc, from), to: to + 1 < doc.lines.length ? lineStart(doc, to + 1) : doc.text.length, text: "" };
}

/** `lines` put after line `after`, each on its own line. */
export function insertAfter(doc: TomlDocument, after: number, lines: string[]): Splice {
  if (after + 1 < doc.lines.length) {
    const at = lineStart(doc, after + 1);
    return { from: at, to: at, text: `${lines.join("\n")}\n` };
  }
  const tail = doc.text.endsWith("\n") || doc.text === "" ? "" : "\n";
  return { from: doc.text.length, to: doc.text.length, text: `${tail}${lines.join("\n")}\n` };
}

/** A value's span given a new value — the comment after it, and the key before it, kept as written. */
export function replaceValue(entry: TomlEntry, value: unknown): Splice {
  return { from: entry.valueStart, to: entry.valueEnd, text: renderValue(value) };
}

/** Splices applied last first, so an earlier one's offsets still hold. */
export function apply(text: string, splices: Splice[]): string {
  let out = text;
  for (const splice of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) {
    out = out.slice(0, splice.from) + splice.text + out.slice(splice.to);
  }
  return out;
}

/** A block appended at the end of the file, one blank line after what is there. */
export function appendBlock(source: string, block: string[]): string {
  const trimmed = source.replace(/\s*$/, "");
  return `${trimmed === "" ? "" : `${trimmed}\n\n`}${block.join("\n")}\n`;
}

/** The indentation of a line, kept for a key written beside it. */
function indentOf(doc: TomlDocument, line: number): string {
  return /^\s*/.exec(doc.lines[line] ?? "")?.[0] ?? "";
}

// ── Finding a table ─────────────────────────────────────────────────────────

/** The header of `[path]` — a plain table, not an element of an array of tables — or none. */
function headerOf(doc: TomlDocument, path: readonly string[]): TomlHeader | undefined {
  return doc.headers.find((header) => !header.array && header.element === undefined && samePath(header.path, path));
}

/** The line after a header's body: the next header's, or the end. */
function bodyEnd(doc: TomlDocument, header: TomlHeader): number {
  return doc.headers.find((other) => other.line > header.line)?.line ?? doc.lines.length;
}

/** The key/values under a header, its own and none of a sub-table's. */
function bodyOf(doc: TomlDocument, header: TomlHeader): TomlEntry[] {
  const end = bodyEnd(doc, header);
  return doc.entries.filter((entry) => entry.start > header.line && entry.start < end);
}

/**
 * `[path]` written inside an ancestor rather than under a header of its own: as dotted keys (`access.mode = …` under
 * `[security]`), or as an inline table (`access = { mode = … }`). Writing `[security.access]` beside either is a table
 * TOML refuses as defined twice.
 */
function implicitly(
  doc: TomlDocument,
  path: readonly string[],
): { kind: "inline"; entry: TomlEntry } | { kind: "dotted"; prefix: string[]; entries: TomlEntry[] } | undefined {
  for (let split = path.length - 1; split >= 0; split -= 1) {
    const parent = path.slice(0, split);
    const rest = path.slice(split);
    const inParent = doc.entries.filter((entry) => entry.element === undefined && samePath(entry.table, parent));
    const inline = inParent.find((entry) => samePath(entry.key, rest));
    if (inline) {
      const value = valueOf(doc, inline);
      if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)) return { kind: "inline", entry: inline };
      return undefined;
    }
    const dotted = inParent.filter((entry) => entry.key.length > rest.length && samePath(entry.key.slice(0, rest.length), rest));
    if (dotted.length > 0) return { kind: "dotted", prefix: rest, entries: dotted };
  }
  return undefined;
}

// ── Tables ──────────────────────────────────────────────────────────────────

/**
 * Insert or update `values` in `[table]`, returning the new file contents.
 *
 * Keys not mentioned in `values` are untouched, which is what makes this safe to call for one setting at a time:
 * writing `api_key` must not silently drop a `base_url` the operator typed by hand.
 */
export function upsertTomlTable(source: string, table: string, values: Record<string, TomlValue>): string {
  const wanted = Object.entries(values);
  if (wanted.length === 0) return source;
  const path = table.split(".");
  const doc = readToml(source);
  const after = upsertIn(doc, path, wanted);
  return checked(source, after, `[${table}]`, (parsed) => Object.assign(tableAt(parsed, path), values));
}

function upsertIn(doc: TomlDocument, path: string[], wanted: [string, TomlValue][]): string {
  const header = headerOf(doc, path);
  if (header) {
    const body = bodyOf(doc, header);
    const splices: Splice[] = [];
    const missing: string[] = [];
    for (const [key, value] of wanted) {
      const entry = body.find((candidate) => samePath(candidate.key, [key]));
      if (entry) splices.push(replaceValue(entry, value));
      else missing.push(`${renderKey(key)} = ${renderValue(value)}`);
    }
    if (missing.length > 0) {
      // Under the table's last value, not at the end of its body: what follows that is blank lines and comments, and
      // a comment just above the next header is the next table's — a key put under it reads as that table's.
      const last = body.at(-1);
      const indent = last ? indentOf(doc, last.start) : "";
      splices.push(insertAfter(doc, last?.end ?? header.line, missing.map((line) => `${indent}${line}`)));
    }
    return apply(doc.text, splices);
  }

  const implicit = implicitly(doc, path);
  if (implicit?.kind === "inline") {
    const merged = { ...(valueOf(doc, implicit.entry) as Parsed), ...Object.fromEntries(wanted) };
    return apply(doc.text, [replaceValue(implicit.entry, merged)]);
  }
  if (implicit?.kind === "dotted") {
    const splices: Splice[] = [];
    const missing: string[] = [];
    const prefix = implicit.prefix.map(renderKey).join(".");
    for (const [key, value] of wanted) {
      const entry = implicit.entries.find((candidate) => samePath(candidate.key, [...implicit.prefix, key]));
      if (entry) splices.push(replaceValue(entry, value));
      else missing.push(`${prefix}.${renderKey(key)} = ${renderValue(value)}`);
    }
    const last = implicit.entries.at(-1)!;
    if (missing.length > 0) splices.push(insertAfter(doc, last.end, missing.map((line) => `${indentOf(doc, last.start)}${line}`)));
    return apply(doc.text, splices);
  }

  return appendBlock(doc.text, [`[${path.map(renderKey).join(".")}]`, ...wanted.map(([key, value]) => `${renderKey(key)} = ${renderValue(value)}`)]);
}

/**
 * Remove one key from a table, leaving everything else alone.
 *
 * "Follow the default" has to be expressible, and it is not the same as writing the default's current value: a key
 * set to 25 because that is what the daemon says today stops tracking the daemon tomorrow. Absent is the only spelling
 * of "whatever the global is".
 *
 * A no-op when the table or the key is not there, so a caller clearing something that was never set does not have to
 * check first.
 */
export function removeTomlKey(source: string, table: string, key: string): string {
  const path = table.split(".");
  const doc = readToml(source);
  const header = headerOf(doc, path);
  let after = source;
  if (header) {
    const entry = bodyOf(doc, header).find((candidate) => samePath(candidate.key, [key]));
    if (entry) after = apply(doc.text, [dropLines(doc, entry.start, entry.end)]);
  } else {
    const implicit = implicitly(doc, path);
    if (implicit?.kind === "inline") {
      const { [key]: _gone, ...kept } = valueOf(doc, implicit.entry) as Parsed;
      after = apply(doc.text, [replaceValue(implicit.entry, kept)]);
    } else if (implicit?.kind === "dotted") {
      const entry = implicit.entries.find((candidate) => samePath(candidate.key, [...implicit.prefix, key]));
      if (entry) after = apply(doc.text, [dropLines(doc, entry.start, entry.end)]);
    }
  }
  if (after === source) return source;
  return checked(source, after, `[${table}] ${key}`, (parsed) => {
    delete tableAt(parsed, path)[key];
  });
}

/**
 * Remove a whole table: its header and body, the sub-tables under it (`[gateways.telegram.nouva.resilience]`, which
 * left behind brought the gateway back at the next boot), and a definition of it inside its parent.
 *
 * Needed because "no gateway configured" has to be expressible from the dashboard: setting every key to an empty
 * string leaves a block that still parses as an enabled-but-broken gateway, which fails later and further away than
 * simply not being there. A body ends at its last value: the comments after it sit above the next header and are the
 * next table's.
 */
export function removeTomlTable(source: string, table: string): string {
  const path = table.split(".");
  const doc = readToml(source);
  const splices: Splice[] = [];
  for (const header of doc.headers) {
    if (header.path.length < path.length || !samePath(header.path.slice(0, path.length), path)) continue;
    const body = bodyOf(doc, header);
    splices.push(dropLines(doc, header.line, body.at(-1)?.end ?? header.line));
  }
  const implicit = splices.length === 0 ? implicitly(doc, path) : undefined;
  if (implicit?.kind === "inline") splices.push(dropLines(doc, implicit.entry.start, implicit.entry.end));
  if (implicit?.kind === "dotted") for (const entry of implicit.entries) splices.push(dropLines(doc, entry.start, entry.end));
  if (splices.length === 0) return source;
  const after = collapseBlankRuns(apply(doc.text, splices));
  return checked(source, after, `[${table}]`, (parsed) => {
    delete tableAt(parsed, path.slice(0, -1))[path.at(-1)!];
  });
}

/** No run of more than one blank line where a removal joined two gaps. */
export function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

