/**
 * A TOML document read as its lines, for the editors in `edit.ts`: which table each line belongs to, and where each
 * key's value starts and ends — across a multi-line array or string — with the comment after it.
 *
 * One reading for every editor. Each used to find its own way through the file, with its own idea of where a string
 * ends: a double-quote regex here, a "the array closes at the first `]`" flag there. A literal `'ann'` was invisible
 * to all of them, a `]` in a comment closed an array that had not, and the continuation lines of a multi-line value
 * were left behind when its first line was replaced. This reads strings, arrays and inline tables the way TOML does,
 * and gives the editors spans to replace rather than lines to guess at.
 *
 * Not a TOML parser: values are located, not evaluated — an editor that needs one's meaning reads it with the real
 * parser (`valueOf`). And not forgiving: a file it cannot read is refused (`TomlReadError`) rather than edited by
 * guesswork, which is how a file the daemon cannot boot from used to be written.
 */

import { parseToml } from "@nouride/runtime";

/** A table header: `[a.b]`, or `[[a.b]]` for an element of an array of tables. */
export interface TomlHeader {
  line: number;
  path: string[];
  array: boolean;
  /** For `[[…]]` and the sub-tables under one: which element of that array, counting from 0. */
  element?: number;
}

/** One `key = value`. Offsets are into the document's text. */
export interface TomlEntry {
  /** The table it is in — `[]` at the top. For an element of an array of tables, the array's path. */
  table: string[];
  element?: number;
  /** The key as written, dotted keys split: `["mode"]`, or `["access", "mode"]` for `access.mode = …`. */
  key: string[];
  /** The lines the entry spans, from its key to the end of its value. */
  start: number;
  end: number;
  /** Where the key begins (after the line's indentation), where the value begins, and where it ends. */
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  /** The comment after the value on its last line, `# …`, or `""`. */
  comment: string;
}

export interface TomlDocument {
  text: string;
  lines: string[];
  headers: TomlHeader[];
  entries: TomlEntry[];
}

/** A file this reading cannot follow — refused rather than edited by guesswork. */
class TomlReadError extends Error {
  override name = "TomlReadError";
}

const BARE_KEY = /[A-Za-z0-9_-]/;

export function readToml(text: string): TomlDocument {
  const lines = text.split("\n");
  const lineOf = lineIndexer(text);
  const headers: TomlHeader[] = [];
  const entries: TomlEntry[] = [];
  let table: string[] = [];
  let element: number | undefined;
  /** How many elements each array of tables has had, by path. */
  const counts = new Map<string, number>();
  let i = 0;

  const fail = (what: string): never => {
    throw new TomlReadError(`line ${lineOf(i) + 1}: ${what}`);
  };
  const spaces = () => {
    while (text[i] === " " || text[i] === "\t") i += 1;
  };
  /** Whitespace, then a comment, then the end of the line — what may follow a header or a value. */
  const lineEnd = (): string => {
    spaces();
    let comment = "";
    if (text[i] === "#") {
      const from = i;
      while (i < text.length && text[i] !== "\n") i += 1;
      comment = text.slice(from, i).replace(/\r$/, "");
    }
    if (text[i] === "\r") i += 1;
    if (i < text.length && text[i] !== "\n") fail(`unexpected "${text[i]}"`);
    i += 1;
    return comment;
  };
  const keyPath = (closer: string): string[] => {
    const path: string[] = [];
    for (;;) {
      spaces();
      path.push(keySegment());
      spaces();
      if (text[i] === ".") {
        i += 1;
        continue;
      }
      if (!text.startsWith(closer, i)) fail(`expected "${closer}" after a key`);
      return path;
    }
  };
  const keySegment = (): string => {
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const from = i;
      skipString();
      return parseToml<{ k: string }>(`k = ${text.slice(from, i)}`).k;
    }
    const from = i;
    while (i < text.length && BARE_KEY.test(text[i]!)) i += 1;
    if (i === from) fail("expected a key");
    return text.slice(from, i);
  };
  const skipString = () => {
    const quote = text[i]!;
    const triple = text.startsWith(quote.repeat(3), i);
    if (triple) {
      const close = quote.repeat(3);
      i += 3;
      for (;;) {
        if (i >= text.length) fail("a multi-line string is not closed");
        if (quote === '"' && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text.startsWith(close, i)) {
          i += 3;
          // Up to two more quotes belong to the string: `""""` ends it with one inside.
          while (text[i] === quote && i < text.length) i += 1;
          return;
        }
        i += 1;
      }
    }
    i += 1;
    for (;;) {
      if (i >= text.length || text[i] === "\n") fail("a string is not closed on its line");
      if (quote === '"' && text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === quote) {
        i += 1;
        return;
      }
      i += 1;
    }
  };
  /** Between the values of an array: whitespace, newlines and comments. */
  const filler = () => {
    for (;;) {
      if (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i += 1;
      else if (text[i] === "#") while (i < text.length && text[i] !== "\n") i += 1;
      else return;
    }
  };
  const skipValue = () => {
    const ch = text[i];
    if (ch === '"' || ch === "'") return skipString();
    if (ch === "[") {
      i += 1;
      for (;;) {
        filler();
        if (text[i] === "]") {
          i += 1;
          return;
        }
        if (i >= text.length) fail("an array is not closed");
        skipValue();
        filler();
        if (text[i] === ",") i += 1;
        else if (text[i] !== "]") fail("expected \",\" or \"]\" in an array");
      }
    }
    if (ch === "{") {
      i += 1;
      spaces();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      for (;;) {
        keyPath("=");
        i += 1;
        spaces();
        skipValue();
        spaces();
        if (text[i] === ",") {
          i += 1;
          spaces();
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return;
        }
        fail("expected \",\" or \"}\" in an inline table");
      }
    }
    // A number, a boolean, a date: up to what ends a value. A date may hold one space, before its time.
    const from = i;
    while (i < text.length && !/[\s,\]}#]/.test(text[i]!)) i += 1;
    if (text[i] === " " && /^\d{4}-\d{2}-\d{2}$/.test(text.slice(from, i)) && /^ \d{2}:/.test(text.slice(i, i + 4))) {
      i += 1;
      while (i < text.length && !/[\s,\]}#]/.test(text[i]!)) i += 1;
    }
    if (i === from) fail("expected a value");
  };

  while (i < text.length) {
    spaces();
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      lineEnd();
      continue;
    }
    if (ch === "#") {
      lineEnd();
      continue;
    }
    if (ch === "[") {
      const line = lineOf(i);
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      const path = keyPath(array ? "]]" : "]");
      i += array ? 2 : 1;
      lineEnd();
      const name = path.join("\u0000");
      if (array) {
        const index = counts.get(name) ?? 0;
        counts.set(name, index + 1);
        table = path;
        element = index;
      } else {
        // A sub-table of an array element belongs to the element it follows: `[mcp_servers.env]` after
        // `[[mcp_servers]]` is that server's env.
        const owner = [...counts.keys()].find((key) => name.startsWith(`${key}\u0000`));
        table = owner ? owner.split("\u0000") : path;
        element = owner ? counts.get(owner)! - 1 : undefined;
        if (owner) {
          headers.push({ line, path, array, element });
          table = path;
          continue;
        }
      }
      headers.push({ line, path, array, ...(element === undefined ? {} : { element }) });
      continue;
    }
    const start = lineOf(i);
    const keyStart = i;
    const key = keyPath("=");
    i += 1;
    spaces();
    const valueStart = i;
    skipValue();
    const valueEnd = i;
    const end = lineOf(valueEnd);
    const comment = lineEnd();
    entries.push({
      table,
      ...(element === undefined ? {} : { element }),
      key,
      start,
      end,
      keyStart,
      valueStart,
      valueEnd,
      comment,
    });
  }

  return { text, lines, headers, entries };
}

/** What a value's text means, read by the real parser. */
export function valueOf(doc: TomlDocument, entry: TomlEntry): unknown {
  return parseToml<{ v: unknown }>(`v = ${doc.text.slice(entry.valueStart, entry.valueEnd)}`).v;
}

/** Same path, segment by segment. */
export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/** The line a text offset falls on, by binary search over where each line starts. */
function lineIndexer(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
}
