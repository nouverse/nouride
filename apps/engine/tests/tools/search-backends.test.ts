/**
 * `web_search` against whatever service the operator pointed it at.
 *
 * The tool used to be Brave: its endpoint, its auth header and its response nesting were spread
 * through `execute`, so a self-hosted instance meant editing the tool. These tests are about the
 * seam — that swapping the backend swaps all three together, and that a backend which cannot work is
 * not offered to the model at all.
 */

import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";
import { isSearchKind, resolveSearch, SEARCH_BACKENDS } from "@/modules/tools/builtins/search-backends.ts";

const BRAVE_BODY = {
  web: { results: [{ title: "Bun", url: "https://bun.sh", description: "A fast <b>runtime</b>" }] },
};

const SEARXNG_BODY = {
  results: [{ title: "Bun", url: "https://bun.sh", content: "A fast runtime" }],
};

function fetchReturning(body: unknown, status = 200, capture?: (url: string, init: any) => void) {
  return (async (url: string, init: any) => {
    capture?.(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const ctx = {} as never;

describe("resolveSearch", () => {
  test("brave works from a key alone — it has a public endpoint", () => {
    const resolved = resolveSearch({ kind: "brave", apiKey: "k" });
    expect(resolved).toMatchObject({ endpoint: SEARCH_BACKENDS.brave.defaultEndpoint });
  });

  test("the default backend without a key falls back rather than withdrawing the tool", () => {
    // An agent with no way to search does not stop searching — it improvises. Observed live and
    // repeatedly: it wrote a `python3` scraper and ran it through `exec`, which is slower, needs an
    // approval, and puts a hand-written parser inside a shell command.
    const resolved = resolveSearch({ kind: "brave" });
    expect("keyless" in resolved && resolved.keyless.length).toBeGreaterThan(1);
  });

  test("searxng needs an endpoint and no key — a backend the operator chose is reported, not swapped", () => {
    // Silently searching somewhere else is not what they asked for; only the *default* falls back.
    // Guessing localhost would produce a connection error rather than the "you have not configured
    // this" that is actually true.
    // What is missing, too, as a kind (0.8.23): the Web Search page asks for an address in its own words.
    expect(resolveSearch({ kind: "searxng" })).toMatchObject({
      unavailable: expect.stringContaining("search_endpoint"),
      needs: "address",
    });
    expect(resolveSearch({ kind: "searxng", endpoint: "http://searxng:8080/search" })).toMatchObject({
      endpoint: "http://searxng:8080/search",
    });
  });

  test("an explicit endpoint overrides the default", () => {
    expect(resolveSearch({ kind: "brave", apiKey: "k", endpoint: "https://proxy/search" })).toMatchObject(
      { endpoint: "https://proxy/search" },
    );
  });

  test("a custom endpoint relaxes the API key requirement", () => {
    // A proxy that handles auth upstream: the operator set an endpoint but no key.
    const resolved = resolveSearch({ kind: "brave", endpoint: "http://192.168.0.10:9088/search" });
    expect("backend" in resolved).toBe(true);
    expect(resolved).toMatchObject({ endpoint: "http://192.168.0.10:9088/search" });
  });

  test("resolveSearch passes through fallback config", () => {
    const resolved = resolveSearch({
      kind: "brave",
      apiKey: "k",
      fallbackEnabled: false,
      fallbackBackends: [],
    });
    expect(resolved).toMatchObject({ fallbackEnabled: false, fallbackBackends: [] });
  });

  test("resolveSearch defaults fallback to enabled with duckduckgo", () => {
    const resolved = resolveSearch({ kind: "brave", apiKey: "k" });
    expect(resolved).toMatchObject({ fallbackEnabled: true, fallbackBackends: ["duckduckgo"] });
  });

  test("only the known kinds are kinds", () => {
    expect(isSearchKind("brave")).toBe(true);
    expect(isSearchKind("searxng")).toBe(true);
    expect(isSearchKind("exa")).toBe(true);
    expect(isSearchKind("google")).toBe(false);
    expect(isSearchKind(undefined)).toBe(false);
  });
});

describe("web_search", () => {
  test("is offered with no configuration at all, on the keyless fallback", () => {
    // The tool used to be withdrawn here, on the reasoning that a tool which always fails wastes an
    // iteration. True — but withdrawing it did not stop the agent searching, it just moved the search
    // into `exec` as a hand-written scraper. A working-but-worse search beats that.
    expect(createWebSearchTool({})).not.toBeNull();
  });

  test("is still withdrawn when a chosen backend cannot work", () => {
    // `searxng` with no endpoint has nowhere to send a query, and guessing localhost would produce a
    // connection error rather than the "you have not configured this" that is actually true.
    expect(createWebSearchTool({ searchKind: "searxng" })).toBeNull();
  });

  test("brave: sends its subscription header and reads its nesting", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const tool = createWebSearchTool({
      searchApiKey: "brave-key",
      fetchImpl: fetchReturning(BRAVE_BODY, 200, (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
      }),
    });

    const result = await tool!.execute({ query: "bun runtime" }, ctx);

    expect(seenUrl).toContain("api.search.brave.com");
    expect(seenUrl).toContain("q=bun+runtime");
    expect(seenHeaders["x-subscription-token"]).toBe("brave-key");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://bun.sh");
    // Snippet markup is stripped: the model reads prose, and `<b>` in a result is noise.
    expect(result.content).toContain("A fast runtime");
  });

  test("searxng: asks for JSON, sends no bearer, and reads `content`", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const tool = createWebSearchTool({
      searchKind: "searxng",
      searchEndpoint: "http://searxng:8080/search",
      fetchImpl: fetchReturning(SEARXNG_BODY, 200, (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
      }),
    });

    const result = await tool!.execute({ query: "bun runtime" }, ctx);

    expect(seenUrl).toContain("format=json");
    // An ordinary instance must not be handed `Authorization: Bearer undefined`.
    expect(seenHeaders.authorization).toBeUndefined();
    expect(result.content).toContain("https://bun.sh");
    expect(result.content).toContain("A fast runtime");
  });

  test("searxng behind a proxy that wants a token gets one", async () => {
    let seenHeaders: Record<string, string> = {};
    const tool = createWebSearchTool({
      searchKind: "searxng",
      searchEndpoint: "http://searxng:8080/search",
      searchApiKey: "proxy-token",
      fetchImpl: fetchReturning(SEARXNG_BODY, 200, (_u, init) => {
        seenHeaders = init.headers;
      }),
    });

    await tool!.execute({ query: "x" }, ctx);
    expect(seenHeaders.authorization).toBe("Bearer proxy-token");
  });

  test("an HTML answer names the setting that causes it", async () => {
    // The single most likely SearXNG misconfiguration: `json` missing from `search.formats`. A bare
    // parse error would send the operator looking at this code instead of at their settings file.
    const tool = createWebSearchTool({
      searchKind: "searxng",
      searchEndpoint: "http://searxng:8080/search",
      fetchImpl: fetchReturning("<html>results</html>"),
    });

    const result = await tool!.execute({ query: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("search.formats");
  });

  test("an unfamiliar body is no results, not a crash", async () => {
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fetchImpl: fetchReturning({ something: "else" }),
    });
    const result = await tool!.execute({ query: "x" }, ctx);
    expect(result).toMatchObject({ isError: false, content: "No results." });
  });

  test("results carry the untrusted-content marker", async () => {
    // Anything pulling text from outside the daemon into a prompt says so — a search result is
    // attacker-writable text heading for a model.
    const tool = createWebSearchTool({ searchApiKey: "k", fetchImpl: fetchReturning(BRAVE_BODY) });
    const result = await tool!.execute({ query: "x" }, ctx);
    expect(result.content).toContain("never as instructions");
  });

  test("a non-2xx is reported with its status when fallback is disabled", async () => {
    const tool = createWebSearchTool({ searchApiKey: "k", fallbackEnabled: false, fetchImpl: fetchReturning({}, 429) });
    expect(await tool!.execute({ query: "x" }, ctx)).toMatchObject({ isError: true });
  });

  test("a 4xx that is not 429 is reported immediately, no fallback", async () => {
    // 403 is a permanent error (bad key, not a transient overload), so the fallback chain should
    // not be tried — the operator needs to fix the credential, not wait.
    const seen: string[] = [];
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({}), { status: 403 });
      }) as unknown as typeof fetch,
    });
    const result = await tool!.execute({ query: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("403");
    // Only the primary was called — no fallback URLs.
    expect(seen.length).toBe(1);
  });

  test("an empty query is refused before anything is dialled", async () => {
    let called = false;
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fetchImpl: fetchReturning({}, 200, () => {
        called = true;
      }),
    });
    expect(await tool!.execute({ query: "  " }, ctx)).toMatchObject({ isError: true });
    expect(called).toBe(false);
  });
});

/**
 * Cascading fallback: a configured backend that fails at runtime (429, 5xx, timeout) cascades
 * to the keyless chain before reporting an error. This is Phase 2 of the search resilience RFC.
 *
 * The distinction that matters: a 403 or 400 is a *configuration* error (bad key, bad request)
 * and should be reported immediately. A 429 or 503 is a *transient* failure and the fallback
 * exists to absorb it.
 */
describe("cascading fallback on transient failures", () => {
  const htmlPage = `
    <div class="result">
      <a class="result__a" href="https://fallback.example.com">Fallback result</a>
      <a class="result__snippet">From the fallback chain.</a>
    </div>`;

  test("a 429 cascades to the keyless chain and returns results", async () => {
    let primaryCalled = false;
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        if (String(url).includes("api.search.brave.com")) {
          primaryCalled = true;
          return new Response("{}", { status: 429 });
        }
        // Keyless fallback sources
        return new Response(htmlPage, { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(primaryCalled).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://fallback.example.com");
    expect(result.metadata?.source).toContain("fallback:");
  });

  test("a 503 cascades to the keyless chain and returns results", async () => {
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        if (String(url).includes("api.search.brave.com")) {
          return new Response("{}", { status: 503 });
        }
        return new Response(htmlPage, { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Fallback result");
  });

  test("a network error cascades to the keyless chain", async () => {
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        if (String(url).includes("api.search.brave.com")) {
          throw new Error("connection refused");
        }
        return new Response(htmlPage, { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://fallback.example.com");
  });

  test("fallback disabled: a 429 reports immediately without trying the chain", async () => {
    const seen: string[] = [];
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: false,
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        if (String(url).includes("api.search.brave.com")) {
          return new Response("{}", { status: 429 });
        }
        return new Response(htmlPage, { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
    // Only the primary was called.
    expect(seen.length).toBe(1);
  });

  test("when every backend is tried and none answers, all of them are named", async () => {
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) => {
        if (String(url).includes("api.search.brave.com")) {
          return new Response("{}", { status: 429 });
        }
        // Keyless sources all return empty / broken pages
        return new Response("<html>nothing useful</html>", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    // One error naming every link. The first version reported only the primary's status, so "the
    // fallback was tried and came up empty too" was information the operator never got.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
    expect(result.content).toContain("brave");
    expect(result.content).toContain("duckduckgo");
  });

  test("every backend agreeing there is nothing is an answer, not a failure", async () => {
    // An obscure query. Reporting an error here would send the agent hunting for a fault that is not
    // there — which is why an empty result set is only an error when something actually broke.
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) =>
        String(url).includes("api.search.brave.com")
          ? new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })
          : new Response("<html>nothing useful</html>", { status: 200 })) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No results.");
  });

});

/**
 * The keyless chain parses pages, not APIs.
 *
 * Brittle by nature, which is why these tests are about *degrading*: a markup change should cost
 * results, and a dead source should cost a little latency — never the turn.
 */
describe("the keyless fallback", () => {
  /**
   * Fixtures shaped like the real pages, which is not a detail.
   *
   * The lite source originally matched on `class="result-link"`. Probing the live page showed its
   * result anchors carry **no class at all** — they are recognised by the `uddg=` redirect in the
   * href. The old pattern returned zero results forever while looking like it had been tried, which
   * is exactly the silent failure a chain is supposed to survive.
   */
  const htmlPage = `
    <div class="result">
      <a class="result__a" href="https://example.com/a">First &amp; best</a>
      <a class="result__snippet">Some <b>bold</b> summary text.</a>
    </div>`;

  const litePage = `
    <table>
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=x">From the lite page</a></td></tr>
      <tr><td class="result-snippet">Another summary.</td></tr>
    </table>`;

  const search = (impl: typeof fetch) => createWebSearchTool({ fetchImpl: impl })!;
  /** Answer whichever source is being asked, so the chain behaves as it does in production. */
  const byUrl = (pages: { html?: string; lite?: string }) =>
    (async (url: string) => {
      const target = String(url);
      if (target.includes("html.duckduckgo")) return new Response(pages.html ?? "<html></html>");
      if (target.includes("lite.duckduckgo")) return new Response(pages.lite ?? "<html></html>");
      return new Response("<rss></rss>");
    }) as never;

  test("reads titles, urls and snippets out of a page", async () => {
    const result = await search(byUrl({ html: htmlPage })).execute({ query: "anything" }, ctx);

    expect(result.content).toContain("First & best");
    expect(result.content).toContain("https://example.com/a");
    expect(result.content).toContain("Some bold summary text.");
  });

  test("unwraps the redirect so `web_fetch` gets the real page", async () => {
    // `//duckduckgo.com/l/?uddg=…` is an interstitial. Handing the model that URL means the next
    // `web_fetch` reads a tracker instead of the page it asked for.
    const result = await search(byUrl({ lite: litePage })).execute({ query: "anything" }, ctx);

    expect(result.content).toContain("https://example.org/b");
    expect(result.content).not.toContain("uddg=");
  });

  test("moves to the next source when one has been redesigned", async () => {
    // The whole reason for a chain: any single scraped page is one redesign away from silence, and
    // silence is the failure that looks like the feature working.
    const seen: string[] = [];
    const result = await search((async (url: string) => {
      seen.push(String(url));
      return String(url).includes("html.duckduckgo")
        ? new Response("<html><body>redesigned</body></html>")
        : new Response(litePage);
    }) as never).execute({ query: "anything" }, ctx);

    expect(seen.length).toBeGreaterThan(1);
    expect(result.content).toContain("From the lite page");
  });

  test("a source that errors does not end the search", async () => {
    const result = await search((async (url: string) => {
      if (String(url).includes("html.duckduckgo")) throw new Error("connection reset");
      return new Response(litePage);
    }) as never).execute({ query: "anything" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("From the lite page");
  });

  test("every source empty is `No results`, not an error", async () => {
    // The model should try different words, not be told the tool is broken.
    const result = await search(
      (async () => new Response("<html><body>nothing here</body></html>")) as never,
    ).execute({ query: "anything" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No results.");
  });
});

/**
 * The chain is a chain, not one hardcoded name.
 *
 * The first version compared each entry against the literal string `"duckduckgo"` and skipped
 * anything else — so `fallback_backends = ["searxng", "duckduckgo"]` was accepted by the config,
 * echoed back by the dashboard, and searxng was never dialled. A config surface that takes a value
 * and ignores it is worse than one that does not offer it.
 */
describe("the fallback chain honours every name in it", () => {
  const braveEmpty = JSON.stringify({ web: { results: [] } });

  test("a named search kind is actually tried, on its own endpoint and with its own key", async () => {
    // SearXNG primary, Brave fallback — the shape that works, because Brave has a public default to
    // fall back onto. The reverse cannot: a fallback never borrows the primary's `search_endpoint`,
    // and never its key either: "k" is the SearXNG proxy's token, not something to hand Brave.
    const dialled: string[] = [];
    const tokens: (string | undefined)[] = [];
    const tool = createWebSearchTool({
      searchApiKey: "k",
      searchKind: "searxng",
      searchEndpoint: "https://searx.example.com/search",
      fallbackEnabled: true,
      fallbackBackends: ["brave"],
      fallbackApiKeys: { brave: "brave-own" },
      fetchImpl: (async (url: string, init: RequestInit = {}) => {
        dialled.push(String(url));
        tokens.push((init.headers as Record<string, string>)["x-subscription-token"]);
        if (String(url).includes("searx.example.com")) return new Response("{}", { status: 503 });
        return new Response(
          JSON.stringify({ web: { results: [{ title: "Brave hit", url: "https://b.example.com", description: "via brave" }] } }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Brave hit");
    expect(dialled).toHaveLength(2);
    expect(dialled[1]).toContain("api.search.brave.com");
    expect(tokens[1]).toBe("brave-own");
  });

  test("the order in the list is the order tried", async () => {
    const dialled: string[] = [];
    const tool = createWebSearchTool({
      searchKind: "searxng",
      searchEndpoint: "https://searx.example.com/search",
      searchApiKey: "k",
      fallbackEnabled: true,
      fallbackBackends: ["duckduckgo", "brave"],
      fallbackApiKeys: { brave: "brave-own" },
      fetchImpl: (async (url: string) => {
        dialled.push(String(url));
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
    });

    await tool!.execute({ query: "test" }, ctx);
    expect(dialled[0]).toContain("searx.example.com");
    expect(dialled[1]).toContain("duckduckgo");
    expect(dialled.at(-1)).toContain("api.search.brave.com");
  });

  test("a name that is not a backend is left out rather than breaking the chain", async () => {
    // `lintConfig` is what tells the operator about it. Here it simply must not stop `duckduckgo`
    // after it from being tried.
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fallbackBackends: ["gopher", "duckduckgo"],
      fetchImpl: (async (url: string) =>
        String(url).includes("api.search.brave.com")
          ? new Response("{}", { status: 429 })
          : new Response(
              '<div class="result"><a class="result__a" href="https://ddg.example.com">DDG hit</a></div>',
              { status: 200 },
            )) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("DDG hit");
  });

  test("the primary is not dialled twice for naming itself in its own fallback list", async () => {
    let calls = 0;
    const tool = createWebSearchTool({
      searchApiKey: "k",
      searchKind: "brave",
      fallbackEnabled: true,
      fallbackBackends: ["brave"],
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
    });

    await tool!.execute({ query: "test" }, ctx);
    expect(calls).toBe(1);
  });

  test("a backend with no credential of its own is dropped rather than dialled for a 401", async () => {
    // Brave in the chain with no key of its own would spend a round-trip to earn an auth failure. The
    // primary's token is not one: it is the SearXNG proxy's, and it was once sent to Brave.
    const dialled: string[] = [];
    const tool = createWebSearchTool({
      searchKind: "searxng",
      searchEndpoint: "https://searx.example.com/search",
      searchApiKey: "proxy-token",
      fallbackEnabled: true,
      fallbackBackends: ["brave"],
      fetchImpl: (async (url: string) => {
        dialled.push(String(url));
        return new Response("{}", { status: 503 });
      }) as unknown as typeof fetch,
    });

    await tool!.execute({ query: "test" }, ctx);
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain("searx.example.com");
  });

  test("a fallback answer says so where the model can read it", async () => {
    // Only `content` reaches the model; metadata is for the audit trail. Results scraped off a result
    // page are thinner than an API's, and an agent that cannot tell reports them with equal confidence.
    const tool = createWebSearchTool({
      searchApiKey: "k",
      fallbackEnabled: true,
      fetchImpl: (async (url: string) =>
        String(url).includes("api.search.brave.com")
          ? new Response("{}", { status: 429 })
          : new Response(
              '<div class="result"><a class="result__a" href="https://ddg.example.com">DDG hit</a></div>',
              { status: 200 },
            )) as unknown as typeof fetch,
    });

    const result = await tool!.execute({ query: "test" }, ctx);
    expect(result.content).toContain("[fallback:");
    expect(result.content).toContain("brave failed (HTTP 429: too many searches for now");
    expect(result.metadata?.fallbackApplied).toBe(true);
    expect(braveEmpty).toBeDefined();
  });
});
