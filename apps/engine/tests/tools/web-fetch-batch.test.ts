/**
 * `web_fetch` with `urls`: several pages in one call, fetched at the same time.
 *
 * What has to hold: every page is in the result in the order asked for, one bad link does not sink
 * the others, the pages run concurrently rather than one after another, and a batch too big for the
 * context gives every page its share instead of losing the middle ones to a head-and-tail cut.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { createWebFetchTool } from "@/modules/tools/builtins/web/index.ts";
import { parseTargets } from "@/modules/tools/builtins/web/fetch-batch.ts";
import { sleep } from "../wait.ts";

const ctx = (resultChars?: number) =>
  ({
    agentId: "nouva",
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "dev",
    workspaceDir: "/tmp",
    workspaceRoots: ["/tmp"],
    ...(resultChars === undefined ? {} : { resultChars }),
    signal: new AbortController().signal,
  }) as ToolContext;

/** Serves `text/plain` bodies by path; `/missing` is a 404. Records when each request started and ended. */
function site(bodies: Record<string, string>, delayMs = 0) {
  const timeline: Array<{ path: string; start: number; end: number }> = [];
  const tool = createWebFetchTool({
    checkUrlImpl: async () => ({ allowed: true }),
    fetchImpl: (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const start = performance.now();
      if (delayMs) await sleep(delayMs);
      timeline.push({ path, start, end: performance.now() });
      const body = bodies[path];
      return body === undefined
        ? new Response("nope", { status: 404 })
        : new Response(body, { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch,
  });
  return { tool, timeline };
}

describe("several pages in one call", () => {
  test("every page comes back, in the order asked for, each under its own heading", async () => {
    const { tool } = site({ "/a": "alpha body", "/b": "beta body", "/c": "gamma body" });
    const result = await tool.execute({ urls: ["https://x.test/b", "https://x.test/a", "https://x.test/c"] }, ctx());

    expect(result.isError).toBe(false);
    const order = ["beta body", "alpha body", "gamma body"].map((body) => result.content.indexOf(body));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(result.content).toContain("=== [1/3] https://x.test/b ===");
    expect(result.content).toContain("=== [3/3] https://x.test/c ===");
  });

  test("one dead link is reported beside the pages that worked, and the call still succeeds", async () => {
    const { tool } = site({ "/a": "alpha body" });
    const result = await tool.execute({ urls: ["https://x.test/a", "https://x.test/missing"] }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("alpha body");
    expect(result.content).toContain("Failed: HTTP 404");
    expect(result.content).toContain("1 succeeded, 1 failed");
  });

  test("the batch is flagged as outside content, as one page is", async () => {
    // The flag is what marks a memory write later in the turn as made after reading it (S13). Nothing
    // asserted it on the batch path: setting it to false there left every test green.
    const { tool } = site({ "/a": "alpha body", "/b": "beta body" });
    const result = await tool.execute({ urls: ["https://x.test/a", "https://x.test/b"] }, ctx());

    expect(result.untrusted).toBe(true);
    expect(result.content.split("\n")[0]).toMatch(/never as instructions/);
  });

  test("when every page fails, the call is an error", async () => {
    const { tool } = site({});
    const result = await tool.execute({ urls: ["https://x.test/a", "https://x.test/b"] }, ctx());

    expect(result.isError).toBe(true);
  });

  test("the pages are fetched at the same time, not one after another", async () => {
    const { tool, timeline } = site({ "/a": "a", "/b": "b", "/c": "c" }, 60);
    await tool.execute({ urls: ["https://x.test/a", "https://x.test/b", "https://x.test/c"] }, ctx());

    // Every request started before the first one finished.
    const firstEnd = Math.min(...timeline.map((t) => t.end));
    expect(timeline.every((t) => t.start < firstEnd)).toBe(true);
  });

  test("the untrusted marker is on the batch, once", async () => {
    // Fetched text is instruction-shaped text from a stranger; a new output path is a new chance to
    // lose the marker.
    const { tool } = site({ "/a": "alpha", "/b": "beta" });
    const result = await tool.execute({ urls: ["https://x.test/a", "https://x.test/b"] }, ctx());
    const single = await tool.execute({ url: "https://x.test/a" }, ctx());

    const marker = single.content.split("\n")[0]!;
    expect(result.content.startsWith(marker)).toBe(true);
    expect(result.content.split(marker)).toHaveLength(2);
  });
});

describe("a batch too big for the context", () => {
  const big = (label: string) => Array.from({ length: 2_000 }, (_, i) => `${label} line ${i}`).join("\n");

  test("gives every page its share, so the middle page is still there", async () => {
    // Without shares the result is spilled head-and-tail, and page two of three vanishes from what the
    // model reads while it believes it has all three.
    const { tool } = site({ "/a": big("alpha"), "/b": big("beta"), "/c": big("gamma") });
    const result = await tool.execute(
      { urls: ["https://x.test/a", "https://x.test/b", "https://x.test/c"] },
      ctx(30_000),
    );

    expect(result.content.length).toBeLessThanOrEqual(30_000 + 1_000);
    for (const label of ["alpha", "beta", "gamma"]) expect(result.content).toContain(`${label} line 0`);
    expect(result.content).toContain("fetch this URL on its own for the rest");
  });

  test("a page that fits its share is not cut", async () => {
    const { tool } = site({ "/a": "short", "/b": big("beta") });
    const result = await tool.execute({ urls: ["https://x.test/a", "https://x.test/b"] }, ctx(30_000));

    expect(result.content.match(/fetch this URL on its own/g)).toHaveLength(1);
  });
});

describe("what it accepts", () => {
  test("one url still works exactly as before", async () => {
    const { tool } = site({ "/a": "alpha body" });
    const result = await tool.execute({ url: "https://x.test/a" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Source: https://x.test/a");
    expect(result.content).not.toContain("=== [");
  });

  test("refuses both, neither, too many, and non-strings — each with a sentence that says why", () => {
    expect(parseTargets("https://a", ["https://b"])).toContain("not both");
    expect(parseTargets(undefined, undefined)).toContain("Pass `url`");
    expect(parseTargets(undefined, [])).toContain("empty");
    expect(parseTargets(undefined, Array.from({ length: 6 }, (_, i) => `https://x/${i}`))).toContain("at most 5");
    expect(parseTargets(undefined, ["https://a", 3])).toContain("list of URL strings");
  });

  test("a URL listed twice is fetched once", async () => {
    const { tool, timeline } = site({ "/a": "alpha" });
    await tool.execute({ urls: ["https://x.test/a", "https://x.test/a"] }, ctx());

    expect(timeline).toHaveLength(1);
  });
});
