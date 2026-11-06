/**
 * `web_fetch` with several URLs: which ones to fetch, and how to hand them back together.
 *
 * The case for it is measured, in `files.ts`: a model asks for one tool call per round trip, and it
 * reaches for an array parameter far more readily than it remembers to put four calls in one message.
 * `web_fetch` was already parallel-safe; what it lacked was a shape that asked for the batch.
 *
 * The part that is not obvious is the budget. A result too big for the context keeps its head and its
 * tail, which is the right cut for one log and the wrong one for five pages: pages two to four would
 * disappear from the excerpt while the model believed it had read them. So each page gets an equal
 * share of what the model will actually see (`ToolContext.resultChars`), and a page cut to fit says so
 * and says how to get the rest.
 */

import type { ToolResult } from "@nouride/shared";
import { UNTRUSTED_PREFIX } from "@/modules/tools/builtins/web/shared.ts";

/** Five: past it, the share each page gets of one result stops being worth reading. */
export const MAX_BATCH_URLS = 5;

/** Below this a page is a title and a sentence, and the batch should have been smaller. */
const MIN_PAGE_SHARE = 2_000;

/** Header, separators and notes around the pages; kept out of each page's share. */
const FRAME_CHARS = 600;

export type FetchedPage =
  | { ok: true; text: string; metadata: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * `url` or `urls`, as a list with duplicates dropped, or the sentence explaining what is wrong.
 *
 * Both at once is refused rather than merged: a model that sends both has usually half-edited one
 * call into another, and guessing which it meant fetches pages nobody asked for.
 */
export function parseTargets(url: unknown, urls: unknown): { urls: string[]; batch: boolean } | string {
  const hasUrl = url !== undefined && url !== null && url !== "";
  const hasUrls = urls !== undefined && urls !== null;
  if (hasUrl && hasUrls) return "Pass `url` or `urls`, not both.";
  if (hasUrl) {
    return typeof url === "string" ? { urls: [url], batch: false } : "`url` must be a string.";
  }
  if (!hasUrls) return "Pass `url` (one page) or `urls` (several).";
  if (!Array.isArray(urls) || urls.some((item) => typeof item !== "string" || item === "")) {
    return "`urls` must be a list of URL strings.";
  }
  const unique = [...new Set(urls as string[])];
  if (unique.length === 0) return "`urls` is empty.";
  if (unique.length > MAX_BATCH_URLS) {
    return `\`urls\` takes at most ${MAX_BATCH_URLS}; split the rest into a second web_fetch in the same reply.`;
  }
  return { urls: unique, batch: true };
}

/**
 * Every page of a batch in one result, in the order they were asked for.
 *
 * `ms` is each page's own time. The slowest of them goes in the metadata because it is the evidence
 * the batch was concurrent: the call's duration comes out near the slowest page, where a serial run
 * would come out near the sum.
 */
export function combineFetches(urls: string[], pages: FetchedPage[], resultChars?: number, ms: number[] = []): ToolResult {
  const share =
    resultChars === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(MIN_PAGE_SHARE, Math.floor((resultChars - FRAME_CHARS) / urls.length));
  const failed = pages.filter((page) => !page.ok).length;

  const sections = pages.map((page, index) => {
    const heading = `=== [${index + 1}/${urls.length}] ${urls[index]} ===`;
    if (!page.ok) return `${heading}\nFailed: ${page.error}`;
    return `${heading}\n${fitPage(page.text, share)}`;
  });

  const summary =
    failed === 0
      ? `Fetched ${urls.length} pages at once.`
      : `Fetched ${urls.length} pages at once: ${urls.length - failed} succeeded, ${failed} failed.`;

  return {
    content: [UNTRUSTED_PREFIX, "", summary, "", sections.join("\n\n")].join("\n"),
    untrusted: true,
    // An error only when nothing came back: one dead link in five is a finding, not a failed call.
    isError: failed === urls.length,
    metadata: {
      urls,
      pages: urls.length,
      failed,
      ...(ms.length > 0 ? { slowestMs: Math.max(...ms) } : {}),
      results: pages.map((page) => (page.ok ? page.metadata : { error: page.error })),
    },
  };
}

/** A page cut to its share at a line boundary, saying so. */
function fitPage(text: string, share: number): string {
  if (text.length <= share) return text;
  const cut = text.lastIndexOf("\n", share);
  let end = cut > share / 2 ? cut : share;
  // Never between the two halves of a surrogate pair: a lone one is rejected by some JSON encoders.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  const kept = text.slice(0, end);
  return (
    `${kept}\n\n[Cut at ${kept.length} of ${text.length} characters so every page in this batch fits: ` +
    "fetch this URL on its own for the rest.]"
  );
}
