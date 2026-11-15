/**
 * Where a page an agent wrote is previewed: the daemon's address for an `html` block of a reply, and for an `.html`
 * file (`web/control/routes/preview.ts` in the engine). The address names what is stored, a turn and where in its
 * reply the block is, or a file by its path: the page's own words are never sent back to be served.
 */

import { createContext } from "react";
import { control } from "@/commons/lib/api.client";

/** From an `html` block's words to the address that previews it, or null where it has none. */
export type HtmlBlockPreview = (text: string) => string | null;

/**
 * Given by what draws a stored reply, a turn that is over: a block drawn anywhere else (a reply still being written,
 * a mission's report, a file) has no stored reply to be read back from, and offers no preview.
 */
export const HtmlBlocks = createContext<HtmlBlockPreview | null>(null);

/** Whether the words before a block end with the fence that opens an `html` block: the daemon's own rule, which decides. */
function opensHtml(before: string): boolean {
  return /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*html\b[^\n]*\n$/i.test(before);
}

/**
 * The previews of one turn's `html` blocks, each by where it is in the turn's reply. A block whose words are not found
 * there as an `html` block, written inside a list and so indented in the reply, has none: the daemon would refuse it.
 */
export function turnHtmlPreview(turnId: string, reply: string): HtmlBlockPreview {
  return (text) => {
    if (!text) return null;
    for (let at = reply.indexOf(text); at >= 0; at = reply.indexOf(text, at + 1)) {
      if (opensHtml(reply.slice(0, at))) return `${control}/preview/turn/${encodeURIComponent(turnId)}?at=${at}&length=${text.length}`;
    }
    return null;
  };
}

/** The preview of an `.html` file among Nouride's files, by its path there. */
export function fileHtmlPreview(path: string): string {
  return `${control}/preview/file?path=${encodeURIComponent(path)}`;
}

/** A file that is a page, by its name. */
export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

/** Whether a fence's language names HTML: a fence may say more than its language. */
export function namesHtml(lang: string | undefined): boolean {
  return (lang ?? "").trim().toLowerCase().split(/\s+/)[0] === "html";
}
