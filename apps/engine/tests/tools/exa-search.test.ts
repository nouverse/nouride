/**
 * `web_search` on Exa, against a fake Exa that answers in Exa's own shape.
 *
 * Exa is the one backend searched with a POST: the query and its options travel in a JSON body, and the key in an
 * `x-api-key` header. So these hold what the request carries as well as what is read back out of the answer, and
 * what a refusal says to the agent — a bare status left it guessing whether the key or the service was at fault.
 */

import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";
import { resolveSearch, SEARCH_BACKENDS } from "@/modules/tools/builtins/search-backends.ts";

const KEY = "exa-test-key-not-real-0000";
const ctx = {} as never;

/**
 * Trimmed from a live answer to `{"query":"bun javascript runtime","contents":{"highlights":{…}}}`: the fields Exa
 * sent, `entities` cut short. The second result came back with an empty title, and every highlight is page text with
 * its line breaks and Markdown headings in it.
 */
const EXA_BODY = {
  requestId: "820cee8b88df9930c8008d85436b9607",
  resolvedSearchType: "",
  results: [
    {
      id: "https://bun.com/",
      title: "Bun — A fast all-in-one JavaScript runtime",
      url: "https://bun.com/",
      highlights: [
        "fast all-in-one JavaScript runtime\n\n# Bun is a fast JavaScript runtime & toolkit. All in one.\n\nRuntime, package manager, test runner and bundler in a single binary.",
      ],
      image: "https://bun.com/share_v4.png",
      entities: [{ id: "https://exa.ai/library/organization/l41txfzgpy7", type: "company", version: 1, properties: { name: "Shenzhen xp Co., Ltd" } }],
    },
    {
      id: "https://bun.com/docs/runtime",
      title: "",
      url: "https://bun.com/docs/runtime",
      highlights: ["# Bun Runtime\n\nExecute JavaScript/TypeScript files, package.json scripts, and executable packages with Bun's fast runtime."],
      image: "https://bun.com/og/docs/runtime.png",
    },
  ],
  costDollars: { total: 0.008 },
};

/** Exa's error body, as it answers a key it does not know. */
const EXA_401 = {
  requestId: "8c6ff10e261a52b7f5d628bf1627198b",
  error: "Invalid API key. Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
  tag: "INVALID_API_KEY",
};

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function fakeExa(answer: unknown, status = 200) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    seen.push({
      url: String(url),
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

describe("exa", () => {
  test("posts the query to Exa's address, the key in x-api-key, asking for a few lines of each page", async () => {
    const exa = fakeExa(EXA_BODY);
    const tool = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fetchImpl: exa.impl });

    await tool!.execute({ query: "bun javascript runtime" }, ctx);

    expect(exa.seen).toHaveLength(1);
    const [request] = exa.seen;
    expect(request!.url).toBe("https://api.exa.ai/search");
    expect(request!.method).toBe("POST");
    expect(request!.headers["x-api-key"]).toBe(KEY);
    expect(request!.headers["content-type"]).toBe("application/json");
    // The query in the body, never in the address, where a proxy's log would keep it.
    expect(request!.url).not.toContain("bun");
    expect(request!.body).toEqual({ query: "bun javascript runtime", numResults: 8, contents: { highlights: { maxCharacters: 400 } } });
  });

  test("reads titles, links and highlights out of Exa's answer, each result one line of text", async () => {
    const exa = fakeExa(EXA_BODY);
    const tool = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fetchImpl: exa.impl });

    const result = await tool!.execute({ query: "bun javascript runtime" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Results for "bun javascript runtime"');
    expect(result.content).toContain("1. Bun — A fast all-in-one JavaScript runtime\n   https://bun.com/\n   fast all-in-one JavaScript runtime # Bun is a fast");
    // An empty title is said as one, and the highlight's line breaks do not leak into the next lines.
    expect(result.content).toContain("2. (untitled)\n   https://bun.com/docs/runtime\n   # Bun Runtime Execute JavaScript/TypeScript files");
    expect(result.metadata?.count).toBe(2);
  });

  test("a result with text but no highlights still has something to read", () => {
    const hits = SEARCH_BACKENDS.exa.parse({ results: [{ title: "T", url: "https://t.example", text: "Some page\ntext." }] });
    expect(hits).toEqual([{ title: "T", url: "https://t.example", snippet: "Some page text." }]);
    expect(SEARCH_BACKENDS.exa.parse({ something: "else" })).toEqual([]);
  });

  test("a 401 says the key was not accepted, and does not fall back over it", async () => {
    const exa = fakeExa(EXA_401, 401);
    const tool = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fallbackEnabled: true, fetchImpl: exa.impl });

    const result = await tool!.execute({ query: "x" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Search failed: exa failed (HTTP 401: the search service did not accept the key)");
    // A wrong key answered from the free sources would look like it works, and nobody would fix it.
    expect(exa.seen).toHaveLength(1);
    expect(result.content).not.toContain(KEY);
  });

  test("an account out of credit and a key refused say so too, and a status with no meaning to add stays bare", async () => {
    const said: Record<number, string> = {};
    for (const status of [402, 403, 400]) {
      const exa = fakeExa({ error: "no", tag: "X" }, status);
      const tool = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fallbackEnabled: false, fetchImpl: exa.impl });
      said[status] = (await tool!.execute({ query: "x" }, ctx)).content;
    }
    expect(said).toEqual({
      402: "Search failed: exa failed (HTTP 402: the search service account has no credit left)",
      403: "Search failed: exa failed (HTTP 403: the search service refused this key)",
      400: "Search failed: exa failed (HTTP 400)",
    });
  });

  test("a 429 says it is a limit, and falls back to the free sources when that is on", async () => {
    const limited = fakeExa({ error: "rate limited", tag: "RATE_LIMIT" }, 429);
    const off = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fallbackEnabled: false, fetchImpl: limited.impl });
    expect(await off!.execute({ query: "x" }, ctx)).toMatchObject({
      isError: true,
      content: "Search failed: exa failed (HTTP 429: too many searches for now, or the plan's limit is used up)",
    });

    const dialled: string[] = [];
    const on = createWebSearchTool({
      searchKind: "exa",
      searchApiKey: KEY,
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        dialled.push(String(url));
        if (String(url).includes("api.exa.ai")) return new Response("{}", { status: 429 });
        return new Response('<div class="result"><a class="result__a" href="https://ddg.example.com">DDG hit</a></div>', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await on!.execute({ query: "x" }, ctx);
    expect(dialled[0]).toBe("https://api.exa.ai/search");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("DDG hit");
    expect(result.content).toContain("exa failed (HTTP 429: too many searches");
  });

  test("without a key it is not offered: only the default falls back to the free sources", () => {
    expect(resolveSearch({ kind: "exa" })).toMatchObject({ unavailable: expect.stringContaining('"exa"'), needs: "key" });
    expect(createWebSearchTool({ searchKind: "exa" })).toBeNull();
    expect(resolveSearch({ kind: "exa", apiKey: KEY })).toMatchObject({ kind: "exa", endpoint: "https://api.exa.ai/search" });
  });

  test("an image search refuses rather than handing back pages", async () => {
    const exa = fakeExa(EXA_BODY);
    const tool = createWebSearchTool({ searchKind: "exa", searchApiKey: KEY, fetchImpl: exa.impl });
    const result = await tool!.execute({ query: "cats", kind: "image" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Image search is not available with the configured search backend");
    expect(exa.seen).toHaveLength(0);
  });
});
