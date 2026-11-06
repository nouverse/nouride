/**
 * Links between knowledge documents (0.8.20, KNOWLEDGE_BASE §12): a Markdown link `[text](…)` or a wikilink `[[…]]`
 * in one document's words that names another document kept here — the memory graph's document → document line. A web
 * address names no document, and a link to a file that is not kept names nothing.
 *
 * Read the way the editors people keep such folders in read them: a Markdown link from the linking document's own
 * folder (from the collection's top when it starts with `/`), which may climb into another collection; a wikilink by a
 * document's file name without its kind, or by its title, in its own collection first and then anywhere it is the only
 * one, and from the collection's top when it holds a `/`.
 *
 * Pure.
 */

import { documentKey } from "./related.ts";

export interface LinkTarget {
  /** `relative` to the linking document's folder; `rooted` at its collection's top; a document's `name`. */
  kind: "relative" | "rooted" | "name";
  target: string;
}

/** `](target)`, the target up to a space or the closing parenthesis, `<…>` allowed around it, a title allowed after. */
const MARKDOWN = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"')]*["'])?\s*\)/g;
/** `[[Target]]`, `[[Target|shown as]]`, `[[Target#Heading]]`. */
const WIKI = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
/** A target with a scheme of its own (`https:`, `mailto:`), or only a place in this document (`#…`). */
const NOT_A_DOCUMENT = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What one text links to, in order, each once. */
export function linksIn(text: string): LinkTarget[] {
  const out = new Map<string, LinkTarget>();
  const add = (link: LinkTarget) => {
    if (link.target) out.set(`${link.kind}:${link.target}`, link);
  };
  for (const match of text.matchAll(MARKDOWN)) {
    const raw = match[1]!.trim();
    if (NOT_A_DOCUMENT.test(raw)) continue;
    const target = decoded(raw.split(/[?#]/)[0]!);
    add(target.startsWith("/") ? { kind: "rooted", target: target.replace(/^\/+/, "") } : { kind: "relative", target });
  }
  for (const match of text.matchAll(WIKI)) {
    const target = match[1]!.trim();
    add(target.includes("/") ? { kind: "rooted", target: target.replace(/^\/+/, "") } : { kind: "name", target });
  }
  return [...out.values()];
}

/** The documents a link can be resolved against: each one's key, and its keys by lowercased file name and title. */
export interface DocumentIndex {
  keys: ReadonlySet<string>;
  byName: ReadonlyMap<string, readonly string[]>;
}

const stem = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");

export function documentIndex(documents: readonly { collection: string; path: string; title: string }[]): DocumentIndex {
  const keys = new Set<string>();
  const byName = new Map<string, string[]>();
  const add = (name: string, key: string) => {
    const at = name.trim().toLowerCase();
    if (!at) return;
    const list = byName.get(at) ?? [];
    if (!list.includes(key)) list.push(key);
    byName.set(at, list);
  };
  for (const document of documents) {
    const key = documentKey(document.collection, document.path);
    keys.add(key);
    add(stem(document.path), key);
    add(document.title, key);
  }
  return { keys, byName };
}

/** `a/./b/../c` as `a/c`; null when it climbs above the knowledge folder or names no file in a collection. */
function normal(parts: readonly string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length >= 2 ? out.join("/") : null;
}

/** The document a link in `from` names, by `documentKey`, or null. Without a kind, a Markdown file is tried. */
export function resolveLink(from: { collection: string; path: string }, link: LinkTarget, index: DocumentIndex): string | null {
  if (link.kind === "name") {
    const named = index.byName.get(link.target.toLowerCase()) ?? [];
    const own = named.filter((key) => key.startsWith(`${from.collection}/`));
    if (own.length === 1) return own[0]!;
    return own.length === 0 && named.length === 1 ? named[0]! : null;
  }
  const folder = link.kind === "relative" ? from.path.split("/").slice(0, -1) : [];
  const joined = normal([from.collection, ...folder, ...link.target.split("/")]);
  if (!joined) return null;
  return [joined, `${joined}.md`].find((key) => index.keys.has(key)) ?? null;
}
