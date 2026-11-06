/**
 * Markdown → the HTML subset Telegram accepts.
 *
 * HTML rather than MarkdownV2, and the choice is not stylistic. MarkdownV2 requires `_ * [ ] ( ) ~ >
 * # + - = | { } . !` to be escaped **everywhere**, including inside ordinary prose, and one missed
 * character fails the entire `sendMessage` — so a model that ends a sentence with a full stop inside
 * emphasis loses the whole reply. HTML needs three characters escaped and its failure mode is a tag
 * that does not render.
 *
 * Telegram's supported tags are a short list; anything outside it is rejected. So this emits only
 * `b`, `i`, `s`, `code`, `pre` and `a`, and everything else becomes text.
 */

import { flattenTable, safeHref, type Node } from "../../commons/markdown.ts";

/**
 * The three characters that can end an element early.
 *
 * Quotes are deliberately not escaped in text: Telegram does not require it, and `&quot;` all over a
 * message that quotes something is worse to read than the character it replaced. Attribute values are
 * a different matter and are handled separately.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** http and https, plus Telegram's own `tg:` deep links. See `safeHref` for why this is filtered. */
const TELEGRAM_SCHEMES = ["http:", "https:", "tg:"];

export function toTelegramHtml(nodes: Node[]): string {
  // A code block keeps the line breaks its fences had: before it, and before what follows. Without the second,
  // `<pre>…</pre>Why…` went out and Telegram lost a line break further on: an approval prompt read "`/deny`This one always
  // asks" (0.8.7, live). Without the first, a persona change's question read "SOUL.md · +2 −2- [# SOUL › …" (0.8.13, live).
  let out = "";
  nodes.forEach((node, index) => {
    if (node.type === "pre" && out !== "" && !out.endsWith("\n")) out += "\n";
    out += renderNode(node);
    if (node.type === "pre" && index < nodes.length - 1) out += "\n";
  });
  return out;
}

function renderNode(node: Node): string {
  switch (node.type) {
    case "text":
      return escapeText(node.value);
    case "bold":
      return `<b>${toTelegramHtml(node.children)}</b>`;
    case "italic":
      return `<i>${toTelegramHtml(node.children)}</i>`;
    case "strike":
      return `<s>${toTelegramHtml(node.children)}</s>`;
    case "code":
      return `<code>${escapeText(node.value)}</code>`;
    case "pre": {
      // The language goes on a `code` class inside `pre`, which is the one nesting Telegram documents.
      const body = escapeText(node.value);
      return node.lang
        ? `<pre><code class="language-${escapeAttribute(node.lang)}">${body}</code></pre>`
        : `<pre>${body}</pre>`;
    }
    case "heading":
      // Telegram has no headings. Bold is the closest mark it has, and the level is dropped rather
      // than faked with size or emoji — a bubble is not a document.
      return `<b>${toTelegramHtml(node.children)}</b>`;
    case "quote":
      return `<blockquote>${toTelegramHtml(node.children)}</blockquote>`;
    case "table":
      // The layout decision is `flattenTable`'s, shared with every other platform that cannot draw a
      // grid; what is left here is drawing bold, which this renderer already knows how to do.
      return toTelegramHtml(flattenTable(node));
    case "link": {
      const href = safeHref(node.href, TELEGRAM_SCHEMES);
      const text = toTelegramHtml(node.children);
      // A rejected scheme keeps the words and loses the link, rather than dropping the sentence.
      return href ? `<a href="${escapeAttribute(href)}">${text}</a>` : text;
    }
  }
}
