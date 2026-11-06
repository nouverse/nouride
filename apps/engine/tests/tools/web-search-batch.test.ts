/**
 * `web_search` with `queries`: several searches in one call, run at the same time.
 *
 * Two weeks on the live box: 92 times a search was followed by another in the *next* reply, one chain
 * of seventeen. See `web/search-batch.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";
import { parseQueries } from "@/modules/tools/builtins/web/search-batch.ts";
import { describeToolCall } from "@/commons/activity.ts";
import { sleep } from "../wait.ts";

/** The keyless DuckDuckGo path, answering with one result named after the query it was asked. */
function toolAnswering(delayMs = 0) {
  const started: number[] = [];
  const finished: number[] = [];
  const tool = createWebSearchTool({
    fetchImpl: (async (input: string | URL) => {
      started.push(performance.now());
      const q = new URL(String(input)).searchParams.get("q") ?? "";
      if (delayMs) await sleep(delayMs);
      finished.push(performance.now());
      if (q.includes("broken")) return new Response("down", { status: 503 });
      return new Response(`<a class="result__a" href="https://example.com/${encodeURIComponent(q)}">About ${q}</a>`, { status: 200 });
    }) as unknown as typeof fetch,
  })!;
  return { tool, started, finished };
}

describe("several queries in one call", () => {
  test("each query's results under its own heading, in the order asked", async () => {
    const { tool } = toolAnswering();
    const result = await tool.execute({ queries: ["bun runtime", "deno runtime"] }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Ran 2 searches at once.");
    expect(result.content.indexOf("=== [1/2] bun runtime ===")).toBeLessThan(result.content.indexOf("=== [2/2] deno runtime ==="));
    expect(result.content).toContain("About bun runtime");
    expect(result.content).toContain("About deno runtime");
  });

  test("they run at the same time", async () => {
    const { tool, started, finished } = toolAnswering(50);
    await tool.execute({ queries: ["a", "b", "c"] }, {} as never);

    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...started)).toBeLessThan(Math.min(...finished));
  });

  test("the marker that fetched text is untrusted is on the batch", async () => {
    const { tool } = toolAnswering();
    const result = await tool.execute({ queries: ["a", "b"] }, {} as never);
    expect(result.content.split("\n")[0]).toMatch(/never as instructions/);
    // And flagged, so a memory write later in the turn is marked as made after it (S13). Setting the
    // flag to false on the batch path left every tools and pipeline test green.
    expect(result.untrusted).toBe(true);
  });

  test("image search stays one query", async () => {
    const { tool } = toolAnswering();
    const result = await tool.execute({ queries: ["a", "b"], kind: "image" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("one `query`");
  });

  test("one query still reads exactly as before", async () => {
    const { tool } = toolAnswering();
    const result = await tool.execute({ query: "bun runtime" }, {} as never);
    expect(result.content).toContain('Results for "bun runtime"');
    expect(result.content).not.toContain("=== [");
  });
});

describe("what it accepts", () => {
  test("refuses both, neither, too many, and blanks — each with a sentence that says why", () => {
    expect(parseQueries("a", ["b"])).toContain("not both");
    expect(parseQueries(undefined, undefined)).toContain("Pass `query`");
    expect(parseQueries(undefined, ["a", "b", "c", "d"])).toContain("at most 3");
    expect(parseQueries(undefined, ["a", " "])).toContain("non-empty strings");
    expect(parseQueries("  ", undefined)).toContain("non-empty string");
  });

  test("a query asked twice is searched once", () => {
    expect(parseQueries(undefined, ["bun", " bun ", "deno"])).toEqual({ queries: ["bun", "deno"], batch: true });
  });

  test("the progress line shows the queries, not the JSON", () => {
    expect(describeToolCall("web_search", { queries: ["bun runtime", "deno runtime"] })).toBe(
      "web_search bun runtime · deno runtime",
    );
  });
});

test("its results end by saying snippets are not pages, one search and several (0.8.12)", async () => {
  // Live: a sentence in the description, read before the call, did not stop a small model citing snippets — it was
  // taken out again for the schema budget; this is read with the snippets.
  const { tool } = toolAnswering();
  const ctx = {} as never;
  for (const args of [{ query: "uk vat rate" }, { queries: ["uk vat rate", "uk vat reduced rate"] }]) {
    const out = String((await tool.execute(args, ctx)).content);
    expect(out.trimEnd().endsWith("An answer built from several sources follows the `research` skill, if you have it.")).toBe(true);
    expect(out).toContain("Snippets are not the pages: open a page with web_fetch before you cite or quote it.");
  }
});
