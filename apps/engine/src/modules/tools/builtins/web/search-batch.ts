/**
 * `web_search` with several queries: which ones to run, and how to hand them back together.
 *
 * Measured on the live box over two weeks: 214 searches, and 92 times a search was followed by
 * another in the *next* reply rather than the same one — one chain ran to seventeen. Most of those
 * were the second and third angle on one question, known before the first result came back. An
 * array parameter is the shape a model reaches for; this is the same change `read(paths)` and
 * `web_fetch(urls)` made.
 */

import type { ToolResult } from "@nouride/shared";
import { SNIPPETS_ARE_NOT_PAGES, UNTRUSTED_PREFIX } from "@/modules/tools/builtins/web/shared.ts";

/** Three: a comparison or a question from three sides. Past it, the results stop being read. */
export const MAX_BATCH_QUERIES = 3;

export type QueryOutcome =
  | { ok: true; text: string; metadata: Record<string, unknown> }
  | { ok: false; error: string };

/** `query` or `queries`, as a list with duplicates dropped, or the sentence explaining what is wrong. */
export function parseQueries(query: unknown, queries: unknown): { queries: string[]; batch: boolean } | string {
  const hasOne = query !== undefined && query !== null && query !== "";
  const hasMany = queries !== undefined && queries !== null;
  if (hasOne && hasMany) return "Pass `query` or `queries`, not both.";
  if (hasOne) {
    return typeof query === "string" && query.trim()
      ? { queries: [query], batch: false }
      : "`query` must be a non-empty string.";
  }
  if (!hasMany) return "Pass `query` (one search) or `queries` (several).";
  if (!Array.isArray(queries) || queries.some((item) => typeof item !== "string" || !item.trim())) {
    return "`queries` must be a list of non-empty strings.";
  }
  const unique = [...new Set((queries as string[]).map((item) => item.trim()))];
  if (unique.length === 0) return "`queries` is empty.";
  if (unique.length > MAX_BATCH_QUERIES) {
    return `\`queries\` takes at most ${MAX_BATCH_QUERIES}; put the rest in a second web_search in the same reply.`;
  }
  return { queries: unique, batch: true };
}

/** Every query's results in one result, in the order asked. An error only when every one failed. */
export function combineSearches(queries: string[], outcomes: QueryOutcome[]): ToolResult {
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  const sections = outcomes.map((outcome, index) => {
    const heading = `=== [${index + 1}/${queries.length}] ${queries[index]} ===`;
    return outcome.ok ? `${heading}\n${outcome.text}` : `${heading}\nFailed: ${outcome.error}`;
  });
  const count = outcomes.reduce((sum, outcome) => sum + (outcome.ok && typeof outcome.metadata.count === "number" ? outcome.metadata.count : 0), 0);
  return {
    content: [UNTRUSTED_PREFIX, "", `Ran ${queries.length} searches at once.`, "", sections.join("\n\n"), "", SNIPPETS_ARE_NOT_PAGES].join("\n"),
    untrusted: true,
    isError: failed === queries.length,
    metadata: { queries, failed, count },
  };
}
