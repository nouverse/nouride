/**
 * The tokenizer and the forgiving tree everything else here reads.
 *
 * Extraction needs nesting. "Which container holds the article" is a question about the tree — the
 * winner is a `<div>` that *contains* the paragraphs, and no amount of regex knows what a tag
 * contains. Nested lists and tables need it too.
 *
 * It is **not** a conformant parser and does not try to be: the output is read by a language model,
 * and the failure mode of getting a malformed table slightly wrong is a slightly worse table.
 */

import { decodeEntities } from "@/modules/tools/builtins/html/entities.ts";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Their content is text, never markup — a `<` inside them does not open a tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

export interface ElementNode {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}

export interface TextNode {
  type: "text";
  value: string;
}

export type Node = ElementNode | TextNode;

/**
 * Parse into a tree, closing whatever the document left open.
 *
 * Real pages omit `</p>` and `</li>` constantly, and a stack that only pops on an explicit close tag
 * ends up with the rest of the document nested inside the first unclosed paragraph. So a close tag
 * with no matching open is dropped rather than unwinding the stack, and the tags that commonly
 * imply a close get one — see `IMPLIED_CLOSE`.
 */
export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { type: "element", name: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let index = 0;

  const top = (): ElementNode => stack[stack.length - 1]!;

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      pushText(top(), html.slice(index));
      break;
    }
    if (lt > index) pushText(top(), html.slice(index, lt));

    // Comments, doctype and processing instructions carry nothing worth reading.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) {
      pushText(top(), html.slice(lt));
      break;
    }

    const rawTag = html.slice(lt + 1, gt);
    index = gt + 1;

    if (rawTag.startsWith("/")) {
      const name = rawTag.slice(1).trim().toLowerCase();
      // Only unwind as far as a matching open. An unmatched `</div>` — extremely common — would
      // otherwise pop a real ancestor and reparent the rest of the page.
      const at = stack.findLastIndex((node) => node.name === name);
      if (at > 0) stack.length = at;
      continue;
    }

    const { name, attrs, selfClosing } = parseTag(rawTag);
    if (!name) continue;

    for (const implied of IMPLIED_CLOSE[name] ?? []) {
      if (top().name === implied) stack.pop();
    }

    const element: ElementNode = { type: "element", name, attrs, children: [] };
    top().children.push(element);

    if (selfClosing || VOID_ELEMENTS.has(name)) continue;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Everything up to the matching close is text by definition, so scanning for `<` here would
      // find operators in minified JavaScript and parse the rest of the file as tags.
      const close = html.toLowerCase().indexOf(`</${name}`, index);
      const end = close === -1 ? html.length : close;
      pushText(element, html.slice(index, end));
      index = end;
      continue;
    }

    stack.push(element);
  }

  return root;
}

/**
 * Opening one of these closes the other.
 *
 * Not the full HTML5 table, just the omissions that actually occur: paragraphs and list items are
 * routinely left open, and table cells nearly always are.
 */
const IMPLIED_CLOSE: Record<string, string[]> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["td", "th", "tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
};

/** The `>` that ends this tag, skipping any inside a quoted attribute value. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseTag(raw: string): { name: string; attrs: Record<string, string>; selfClosing: boolean } {
  const selfClosing = raw.trimEnd().endsWith("/");
  const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;

  const match = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
  if (!match) return { name: "", attrs: {}, selfClosing };

  const name = match[1]!.toLowerCase();
  const attrs: Record<string, string> = {};

  const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  attrPattern.lastIndex = match[0].length;
  for (let m = attrPattern.exec(body); m; m = attrPattern.exec(body)) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }

  return { name, attrs, selfClosing };
}

function pushText(parent: ElementNode, raw: string): void {
  if (!raw) return;
  parent.children.push({ type: "text", value: raw });
}

// ── walking it ───────────────────────────────────────────────────────────────

export function findFirst(node: ElementNode, name: string): ElementNode | null {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.name === name) return child;
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}

export function collect(node: ElementNode, ...names: string[]): ElementNode[] {
  const wanted = new Set(names);
  const found: ElementNode[] = [];
  const walk = (current: ElementNode): void => {
    for (const child of current.children) {
      if (child.type !== "element") continue;
      if (wanted.has(child.name)) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

export function rawText(node: Node): string {
  if (node.type === "text") return node.value;
  return node.children.map(rawText).join("");
}

/**
 * Runs of whitespace are formatting in HTML, never content — outside `<pre>`.
 *
 * Used by both readers of the tree: the serializer collapses every text node it renders, and the
 * metadata reader collapses attribute values, where a `content="…"` written across three indented
 * source lines is one sentence.
 */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}
