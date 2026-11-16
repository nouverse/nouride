/**
 * Where a page an agent wrote is previewed: the daemon's address for an `html` block of a reply, for HTML written
 * straight into one (`html-run.ts`), and for an `.html` file (`web/control/routes/preview.ts` in the engine). The
 * address names what is stored, a turn and where in its reply the HTML is, or a file by its path: the page's own
 * words are never sent back to be served.
 */

import { createContext } from "react";
import { control } from "@/commons/lib/api.client";
import { isHtmlRun } from "@/commons/lib/html-run";

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
 * The previews of one turn's `html` blocks, each by where it is in the turn's reply: after a fence that names `html`,
 * or a run of HTML written with no fence. A block whose words are not found there as either, written inside a list
 * and so indented in the reply, has none: the daemon would refuse it.
 */
export function turnHtmlPreview(turnId: string, reply: string): HtmlBlockPreview {
  return (text) => {
    if (!text) return null;
    for (const [at, length] of writtenAt(reply, text)) {
      if (opensHtml(reply.slice(0, at)) || isHtmlRun(reply, at, length)) return `${control}/preview/turn/${encodeURIComponent(turnId)}?at=${at}&length=${length}`;
    }
    return null;
  };
}

/**
 * Where a block's words are in a reply, each as a place and a length: as they are, and as whole lines written under
 * something (a list's item), where each line begins with the indent the block is drawn without. The address names the
 * lines as the reply holds them, indent and all.
 */
function* writtenAt(reply: string, text: string): Generator<[number, number]> {
  for (let at = reply.indexOf(text); at >= 0; at = reply.indexOf(text, at + 1)) yield [at, text.length];
  const lines = text.split("\n");
  for (let found = reply.indexOf(lines[0]!); found >= 0; found = reply.indexOf(lines[0]!, found + 1)) {
    const start = reply.lastIndexOf("\n", found - 1) + 1;
    const indent = reply.slice(start, found);
    if (indent === "" || indent.trim() !== "") continue;
    let end = start;
    const held = lines.every((line, index) => {
      const next = reply.indexOf("\n", end);
      const written = reply.slice(end, next < 0 ? reply.length : next);
      // A line of the block, under the same indent or under less where it is short of it (an empty line).
      const same = written.startsWith(indent) ? written.slice(indent.length) === line : written.trimStart() === line && written.length - line.length <= indent.length;
      if (same) end = index < lines.length - 1 ? (next < 0 ? reply.length : next + 1) : end + written.length;
      return same && (index === lines.length - 1 || next >= 0);
    });
    if (held) yield [start, end - start];
  }
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
