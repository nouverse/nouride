/**
 * Markdown → WhatsApp's own markup.
 *
 * WhatsApp has no `parse_mode`: whatever bytes go over the bridge are what the phone draws, and its
 * marks are not markdown's. `*one asterisk*` is bold there and `**two**` is literally two asterisks,
 * so a model writing ordinary markdown produced `**bold**` on screen — every reply, since the adapter
 * existed. The engine cannot fix that by writing WhatsApp markup upstream, because the same reply
 * text goes to Discord, where `*one*` is italic. It is a rendering difference, so it stops here
 * (invariant 2).
 *
 * The output is unescapable, and that is a property worth stating rather than a gap. WhatsApp has no
 * escape mechanism, so a literal asterisk a model wrote in prose will be read as a mark by the phone
 * no matter what this function does. Nothing here can prevent it; what it can do is not *add* to the
 * problem, which is why every mark it emits comes from a parsed node rather than from a pattern
 * matched over the final string.
 */

import { flattenTable, safeHref, type Node } from "../../commons/markdown.ts";

export function toWhatsAppText(nodes: Node[]): string {
  return nodes.map(renderNode).join("");
}

function renderNode(node: Node): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "bold":
      return wrap("*", toWhatsAppText(node.children));
    case "italic":
      return wrap("_", toWhatsAppText(node.children));
    case "strike":
      return wrap("~", toWhatsAppText(node.children));
    case "code":
      return wrap("`", node.value);
    case "pre":
      // The language tag is dropped: WhatsApp's monospace block has no highlighting, and a stray
      // `ts` on the first line reads as part of the listing.
      return `\`\`\`\n${node.value}\n\`\`\``;
    case "heading":
      // Bold, like Telegram, and for the same reason — there is no heading to map onto.
      return wrap("*", toWhatsAppText(node.children));
    case "quote": {
      // WhatsApp draws a quote from a `>` on *each* line, not from the first one. A multi-line quote
      // prefixed once loses the bar on every line after the first.
      const body = toWhatsAppText(node.children);
      return body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    case "table":
      return toWhatsAppText(flattenTable(node));
    case "link": {
      const text = toWhatsAppText(node.children);
      const href = safeHref(node.href);
      // WhatsApp linkifies a bare URL and has no anchor syntax, so the target has to be visible to be
      // reachable at all. When the words *are* the URL, showing it twice is noise.
      if (!href) return text;
      return text && text !== href ? `${text} (${href})` : href;
    }
  }
}

/**
 * Wrap in a mark, keeping the whitespace outside it.
 *
 * WhatsApp will not open a mark that is followed by a space, so `* text *` draws as three literal
 * tokens. Markdown is happy to capture the padding — `** bold **` parses — and a model writing to a
 * table cell produces exactly that, which is how the flattened output would have lost its bold on the
 * one platform this file exists to serve.
 */
function wrap(mark: string, inner: string): string {
  // Every part of the pattern may be empty, so it matches any string; `?? []` is for the type alone.
  const [, lead = "", body = "", tail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? [];
  return body ? `${lead}${mark}${body}${mark}${tail}` : inner;
}
