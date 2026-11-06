/**
 * YAML frontmatter, the small part of YAML memory files use — written here, read back here, and read
 * by Obsidian as properties.
 *
 * Written in one shape only: `key: value`, strings double-quoted when they need it, lists in flow
 * style (`people: ["[[people/gading]]"]`). Read more leniently, because a person edits these files by
 * hand: block lists (`- item` lines), single quotes, bare words. Anything else in a line is skipped,
 * not fatal — one odd property must not make a conversation unreadable.
 *
 * Pure.
 */

export type FrontValue = string | number | string[];
export type Front = Record<string, FrontValue>;

const FENCE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/** A string YAML reads back as the same string without quotes — anything else is quoted. */
function bare(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:+-]*$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/:\s/.test(value) && !/^\d+(\.\d+)?$/.test(value);
}

function quote(value: string): string {
  return bare(value) ? value : JSON.stringify(value);
}

function renderValue(value: FrontValue): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  return quote(value);
}

/** The frontmatter block and the body after it. Keys in the order given; empty lists and strings are left out. */
export function renderFront(front: Front, body: string): string {
  const lines = Object.entries(front)
    .filter(([, value]) => !(Array.isArray(value) && value.length === 0) && value !== "")
    .map(([key, value]) => `${key}: ${renderValue(value)}`);
  const text = body.replace(/^\n+/, "");
  return `---\n${lines.join("\n")}\n---\n${text ? `\n${text.endsWith("\n") ? text : `${text}\n`}` : ""}`;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** Split a flow list on commas outside quotes: `["a, b", c]`. */
function flowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoteChar: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quoteChar) {
      current += char;
      if (char === "\\" && quoteChar === '"') {
        current += inner[i + 1] ?? "";
        i += 1;
      } else if (char === quoteChar) quoteChar = null;
    } else if (char === '"' || char === "'") {
      quoteChar = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

function scalar(raw: string): string | number {
  const value = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

/** The frontmatter and the body, or null when the text has no frontmatter. */
export function parseFront(text: string): { front: Front; body: string } | null {
  const match = FENCE.exec(text);
  if (!match) return null;
  const front: Front = {};
  let list: string | null = null;
  for (const raw of match[1]!.split("\n")) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && list) {
      (front[list] as string[]).push(unquote(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (!pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];
    if (value === "") {
      front[key] = [];
      list = key;
    } else if (value.trim().startsWith("[")) {
      front[key] = flowItems(value.trim().replace(/^\[/, "").replace(/\]$/, ""));
      list = null;
    } else {
      front[key] = scalar(value);
      list = null;
    }
  }
  return { front, body: text.slice(match[0].length).replace(/^\n/, "") };
}

/** A field as text, whatever shape a hand edit left it in. */
export function frontText(front: Front, key: string): string | undefined {
  const value = front[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(", ") || undefined;
  return String(value) || undefined;
}

/** A field as a list; a single value becomes a list of one. */
export function frontList(front: Front, key: string): string[] {
  const value = front[key];
  if (value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** `[[people/gading]]` → `people/gading`; anything that is not a wikilink is returned as it is. */
export function unlink(value: string): string {
  const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(value.trim());
  return match ? match[1]! : value.trim();
}

export function link(target: string): string {
  return `[[${target}]]`;
}
