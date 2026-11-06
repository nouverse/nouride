/**
 * The serializer: a page as headings, lists, links, code and tables, and nothing else.
 *
 * The flattener this replaced threw away the structure that says what things are. Flattened, a
 * heading and a caption are the same string; a code block is prose with odd spacing; a table is
 * words in a row with nothing saying which column they came from. The model then has to infer all of
 * it from wording, and where it infers wrong there is nothing in the text to correct it. Markdown is
 * the cheapest possible fix: `## Rate limits` costs three characters more than `Rate limits` and
 * removes the guess.
 *
 * Structure is kept only where it changes meaning. Bold and italic survive because emphasis
 * sometimes is the point; colour, alignment and font size do not, because they never reach a model
 * as anything but noise it has to skip.
 */

import { decodeEntities } from "@/modules/tools/builtins/html/entities.ts";
import { contentChildren, isNoise } from "@/modules/tools/builtins/html/extract.ts";
import { documentTitle } from "@/modules/tools/builtins/html/metadata.ts";
import { collapse, collect, findFirst, rawText, type ElementNode, type Node } from "@/modules/tools/builtins/html/parse.ts";
import { absolutize, imageSource, isTrackingPixel, unwrapImageProxy } from "@/modules/tools/builtins/html/urls.ts";

interface Context {
  /** Set inside `<pre>`, where whitespace is content rather than formatting. */
  pre: boolean;
  /**
   * The URL the page came from, when the caller knows it.
   *
   * Carried all the way down because the links and images in the body are the half of the document
   * a reader navigates by, and half the pages on the web write them relative. `[the docs](/limits)`
   * is a source the agent cannot open and cannot ask about — see `urls.ts`.
   */
  baseUrl?: string;
}

/** The chosen content container as Markdown, with the blank lines normalised. */
export function renderMarkdown(content: ElementNode, baseUrl?: string): string {
  return tidy(render(content, { pre: false, baseUrl }));
}

/**
 * The heading the document should open with.
 *
 * `<h1>` first: a page's `<title>` usually carries the site name too ("Rate limits — Example
 * Docs"), and the heading is the part that says what this page is. The `<title>` is not lost by
 * preferring the `<h1>` — it is in the frontmatter, under its own name.
 */
export function pageHeading(root: ElementNode): string {
  const heading = findFirst(root, "h1");
  if (heading) {
    const text = tidy(render(heading, { pre: false })).replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return documentTitle(root);
}

function render(node: Node, ctx: Context): string {
  if (node.type === "text") {
    const decoded = decodeEntities(node.value);
    return ctx.pre ? decoded : collapse(decoded);
  }
  if (isNoise(node)) return "";

  const inner = (next: Partial<Context> = {}): string =>
    contentChildren(node).map((child) => render(child, { ...ctx, ...next })).join("");

  switch (node.name) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const text = inner().trim();
      return text ? `\n\n${"#".repeat(Number(node.name[1]))} ${text}\n\n` : "";
    }

    case "p": case "div": case "section": case "article": case "main":
    case "blockquote": case "dl": case "dt": case "dd": case "figure": case "figcaption": {
      const text = inner().trim();
      if (!text) return "";
      if (node.name === "blockquote") {
        return `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      }
      return `\n\n${text}\n\n`;
    }

    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";

    case "strong": case "b": {
      const text = inner().trim();
      return text ? `**${text}**` : "";
    }
    case "em": case "i": {
      const text = inner().trim();
      return text ? `*${text}*` : "";
    }
    case "del": case "s": {
      const text = inner().trim();
      return text ? `~~${text}~~` : "";
    }

    case "code": {
      if (ctx.pre) return inner();
      const text = inner().trim();
      if (!text) return "";
      // A backtick inside the span needs a longer fence than the content's longest run.
      const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${text}${fence}`;
    }

    case "pre": {
      const text = inner({ pre: true }).replace(/^\n+|\s+$/g, "");
      if (!text) return "";
      return `\n\n\`\`\`${languageOf(node)}\n${text}\n\`\`\`\n\n`;
    }

    case "ul": case "ol":
      return `\n\n${renderList(node, ctx)}\n\n`;

    case "a": {
      if (isPermalink(node)) return "";
      const text = oneLine(inner());
      const href = node.attrs.href?.trim() ?? "";
      if (!text) return "";
      // In-page and script hrefs carry nothing the model can act on, so the link text is kept and
      // the target dropped rather than emitting `[text](#)`.
      if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return text;
      return `[${text}](${absolutize(href, ctx.baseUrl) ?? href})`;
    }

    case "img": {
      // A 1×1 gif has nothing to show and no alt text worth keeping; it is analytics, and rendering
      // it put a bare `![](…/pixel.gif)` in the middle of the prose.
      if (isTrackingPixel(node.attrs)) return "";
      const alt = (node.attrs.alt ?? "").trim();
      // Not `attrs.src`: a lazy-loading page keeps the real URL somewhere else, and reading only
      // `src` there reports a page full of diagrams as a page with no images at all.
      const source = imageSource(node.attrs);
      const usable = source ? unwrapImageProxy(absolutize(source, ctx.baseUrl) ?? source) : "";
      if (!alt && !usable) return "";
      // With no base URL a relative src stays as the page wrote it, which is what links have always
      // done. A `data:` URI is the one thing dropped outright — see `imageSource`.
      return usable ? `![${alt}](${usable})` : `![${alt}]`;
    }

    case "table":
      return `\n\n${renderTable(node, ctx)}\n\n`;

    // Rendered by `renderTable`; reaching them here means the table was malformed, and their text
    // is still worth keeping.
    case "tr": case "td": case "th": case "thead": case "tbody": case "tfoot":
      return inner();

    default:
      return inner();
  }
}

/**
 * Link text, flattened to the one line the syntax allows.
 *
 * A card on a blog index is `<a>` around a `<div>` and an `<h2>`, and rendered literally that is
 * `[![alt](img)\n\n## Title](url)` — which is not a link at all. Markdown closes `[` on the same
 * block, so everything between it and the `](url)` two paragraphs later reads as bracket characters,
 * and the URL the reader wanted is not attached to anything. Same reasoning as `renderTable`
 * flattening a cell: the structure cannot be expressed here, and the target is the part worth
 * keeping.
 */
function oneLine(text: string): string {
  return text.replace(/^#{1,6}\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
}

/**
 * The `#` that docs sites hang off every heading.
 *
 * `<h2 id="setup">Setup<a href="#setup" class="anchor">#</a></h2>` is the near-universal pattern,
 * and rendering it produced `## Setup#` on every heading of every generated site.
 *
 * **Judged by the glyph, deliberately not by the class.** The first version of this also treated
 * `class="anchor"` and `aria-label="Permalink"` as proof, which looked more thorough and was wrong:
 * MDN wraps the *entire heading text* in `<a href="#status" class="anchor-link">Status</a>`, so the
 * class test deleted every heading on the page. Caught against a real page, not by a fixture —
 * fixtures are written by whoever holds the assumption.
 *
 * The glyph test needs no such backstop. A generator that uses an icon instead of a character emits
 * an anchor with no text at all, which the caller already renders as nothing.
 */
function isPermalink(anchor: ElementNode): boolean {
  if (!(anchor.attrs.href?.trim() ?? "").startsWith("#")) return false;
  return /^[#¶§¤†‡🔗∞]$/u.test(rawText(anchor).trim());
}

/** `class="language-ts"` / `class="lang-ts"`, or `data-language="ts"`, on the `<pre>` or its `<code>`. */
function languageOf(pre: ElementNode): string {
  const code = pre.children.find(
    (child): child is ElementNode => child.type === "element" && child.name === "code",
  );
  // The attribute first: it is unambiguous where it exists, while a class list is a guess among
  // whatever else the highlighter put there.
  const declared = (
    pre.attrs["data-language"] ??
    pre.attrs["data-lang"] ??
    code?.attrs["data-language"] ??
    code?.attrs["data-lang"] ??
    ""
  ).trim().toLowerCase();
  if (/^[a-z0-9+#-]{1,20}$/.test(declared)) return declared;

  const classes = `${pre.attrs.class ?? ""} ${code?.attrs.class ?? ""}`.toLowerCase();
  const match = /(?:language|lang|highlight)[-_]([a-z0-9+#]+)/.exec(classes);
  return match?.[1] ?? "";
}

/**
 * A list, with every level indented exactly once.
 *
 * A nested list is rendered flat and then indented by its *parent*, as one of that item's
 * continuation lines. The alternative — each level indenting itself by its own depth — is the same
 * indentation applied twice, and produces four spaces per level where markdown wants two. Depth is
 * therefore not tracked at all: it is however many times the recursion has been through here.
 */
function renderList(list: ElementNode, ctx: Context): string {
  const ordered = list.name === "ol";
  const start = Number.parseInt(list.attrs.start ?? "1", 10) || 1;
  const lines: string[] = [];
  let index = start;

  for (const child of list.children) {
    if (child.type !== "element" || child.name !== "li" || isNoise(child)) continue;

    const text = child.children.map((node) => render(node, ctx)).join("").trim();
    if (!text) continue;

    const marker = ordered ? `${index}.` : "-";
    index += 1;

    // Continuation lines sit under the marker, so a nested list stays nested and a paragraph inside
    // an item does not read as a sibling of the list.
    const [first = "", ...rest] = text.split("\n");
    lines.push(`${marker} ${first}`);
    for (const line of rest) lines.push(line.trim() ? `  ${line}` : "");
  }

  return lines.join("\n");
}

/**
 * A GFM pipe table, when the shape allows one.
 *
 * Cells are flattened to a single line: a table cell containing paragraphs cannot be expressed in
 * pipe syntax at all, and the alternative — giving up and emitting the text run together — loses
 * which column each value came from, which is the only thing a table is for.
 */
function renderTable(table: ElementNode, ctx: Context): string {
  const rows: string[][] = [];
  for (const tr of collect(table, "tr")) {
    const cells = tr.children
      .filter((c): c is ElementNode => c.type === "element" && (c.name === "td" || c.name === "th"))
      .map((cell) =>
        render(cell, ctx)
          .replace(/\s*\n\s*/g, " ")
          .replace(/\|/g, "\\|")
          .trim(),
      );
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]): string =>
    `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`;

  const [head = [], ...body] = rows;
  return [pad(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(pad)].join("\n");
}

/**
 * Normalise the blank lines the block rules above leave behind.
 *
 * Trailing whitespace only. Stripping *leading* whitespace is the obvious next line to write and it
 * silently destroys the two places indentation is content rather than formatting: a nested list
 * stops being nested, and code inside a fence stops being runnable. Nothing needs that rule anyway —
 * text nodes are already collapsed as they are rendered, so the only indentation that reaches here
 * is indentation this file put there on purpose.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
