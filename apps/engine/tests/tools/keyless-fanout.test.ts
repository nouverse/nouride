/**
 * The keyless sources are asked at once, each under its own deadline, and merged.
 *
 * The chain before this asked them one after another with no deadline at all, so a DuckDuckGo that
 * was throttling us — and hanging rather than refusing — made every search as slow as that socket.
 * See `searchKeyless` in `web/search.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";
import { KEYLESS_PROVIDERS } from "@/modules/tools/builtins/keyless-sources.ts";
import { newsEdition } from "@/modules/tools/builtins/keyless-editions.ts";
import { extractResults, looksPoisoned } from "@/modules/tools/builtins/keyless-extract.ts";
import { DEFAULT_SEARCH_INTENT } from "@/modules/tools/builtins/keyless-types.ts";
import { sleep } from "../wait.ts";

const ctx = {} as never;
const provider = (name: string) => KEYLESS_PROVIDERS.find((p) => p.name === name)!;

const ddgPage = (...urls: string[]) =>
  urls.map((u, i) => `<a class="result__a" href="${u}">Web result ${i + 1}</a><a class="result__snippet">snippet</a>`).join("\n");

const GITHUB = JSON.stringify({
  items: [{ full_name: "oven-sh/bun", html_url: "https://github.com/oven-sh/bun", description: "Incredibly fast JS runtime", stargazers_count: 80000 }],
});
const HN = JSON.stringify({ hits: [{ title: "Show HN: Bun 2", url: "", objectID: "42", points: 300, num_comments: 120 }] });
const SO = JSON.stringify({ items: [{ title: "Bun &amp; SQLite WAL?", link: "https://stackoverflow.com/q/1", score: 5, answer_count: 2, is_answered: true, tags: ["bun"] }] });
const WIKI = JSON.stringify({ query: { search: [{ title: "Bun (software)", snippet: 'A <span class="searchmatch">runtime</span>' }] } });

/** Answer each source the way the live one does. Anything not listed answers nothing useful. */
function sources(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const dialled: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    dialled.push(url);
    for (const [needle, answer] of Object.entries(overrides)) if (url.includes(needle)) return answer();
    if (url.includes("html.duckduckgo") && url.includes("site%3Areddit.com"))
      return new Response(ddgPage("https://www.reddit.com/r/bun/comments/1/x/", "https://example.com/not-reddit"));
    if (url.includes("html.duckduckgo")) return new Response(ddgPage("https://bun.sh/", "https://example.com/a"));
    if (url.includes("bing.com"))
      return new Response(
        "<rss><channel><item><title>Bing self</title><link>http://www.bing.com:80/search?q=x</link></item>" +
          "<item><title>Bing hit</title><link>https://bing-only.example.com/</link><description>d</description></item></channel></rss>",
      );
    if (url.includes("api.github.com")) return new Response(GITHUB);
    if (url.includes("hn.algolia.com")) return new Response(HN);
    if (url.includes("api.stackexchange.com")) return new Response(SO);
    if (url.includes("wikipedia.org")) return new Response(WIKI);
    return new Response("<html></html>");
  }) as unknown as typeof fetch;
  return { impl, dialled };
}

describe("asking every keyless source at once", () => {
  test("general engines lead, community sources follow, nothing is listed twice", async () => {
    const { impl } = sources();
    const result = await createWebSearchTool({ fetchImpl: impl })!.execute(
      { query: "bun sqlite", sources: ["web", "code", "forum", "wiki"] },
      ctx,
    );

    expect(result.isError).toBe(false);
    const c = result.content;
    expect(c).toContain("https://bun.sh/");
    expect(c).toContain("https://bing-only.example.com/");
    expect(c).toContain("oven-sh/bun (★80000, GitHub)");
    expect(c).toContain("https://www.reddit.com/r/bun/comments/1/x/");
    expect(c).toContain("Bun & SQLite WAL? (Stack Overflow)");
    expect(c).toContain("https://en.wikipedia.org/wiki/Bun_(software)");
    // Hacker News story with no link of its own points at the discussion.
    expect(c).toContain("https://news.ycombinator.com/item?id=42");
    expect(c.indexOf("https://bun.sh/")).toBeLessThan(c.indexOf("GitHub"));
    // Found by DuckDuckGo twice (plain and via the reddit filter): listed once.
    expect(c.split("https://example.com/a").length - 1).toBe(1);
    expect(result.metadata?.source).toContain("duckduckgo-html");
    expect(result.metadata?.source).toContain("github");
  });

  test("Bing's links to its own result page are not results; the reddit source keeps only reddit", async () => {
    expect(extractResults(
      "<rss><item><title>self</title><link>http://www.bing.com:80/search?q=x</link></item><item><title>ok</title><link>https://a.example/</link></item></rss>",
      provider("bing"),
    ).map((r) => r.url)).toEqual(["https://a.example/"]);

    expect(
      extractResults(ddgPage("https://example.com/x", "https://www.reddit.com/", "https://old.reddit.com/r/a/"), provider("reddit")).map((r) => r.url),
    ).toEqual(["https://old.reddit.com/r/a/"]);
  });

  test("a JSON source answering a rate-limit page contributes nothing rather than throwing", () => {
    expect(extractResults("<html>slow down</html>", provider("github"))).toEqual([]);
    expect(extractResults('{"message":"API rate limit exceeded"}', provider("github"))).toEqual([]);
  });

  test("every source is dialled before any has answered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { impl, dialled } = sources();
    const slow = (async (input: string | URL) => {
      await gate;
      return impl(input as string);
    }) as unknown as typeof fetch;
    const pending = createWebSearchTool({ fetchImpl: slow })!.execute({ query: "q" }, ctx);
    await sleep(5);
    expect(dialled.length).toBe(0);
    release();
    await pending;
    // Every default source, but the backup, which is only asked when the general engines come back
    // empty.
    const intent = DEFAULT_SEARCH_INTENT;
    expect(dialled.length).toBe(
      KEYLESS_PROVIDERS.filter((p) => p.tier !== "backup" && intent.groups.includes(p.group) && (!p.when || p.when(intent))).length,
    );
    expect(dialled.some((u) => u.includes("lite.duckduckgo"))).toBe(false);
  });

  test("a source that hangs does not hold the search once a general engine has answered", async () => {
    const { impl } = sources({ "api.github.com": () => new Promise<Response>(() => {}) });
    const started = performance.now();
    const result = await createWebSearchTool({ fetchImpl: impl })!.execute({ query: "q", sources: ["web", "code"] }, ctx);

    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result.content).toContain("https://bun.sh/");
    expect(result.content).not.toContain("GitHub");
  });

  test("with every general engine empty, the backup is asked", async () => {
    const lite = '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2F">From lite</a>';
    const { impl, dialled } = sources({
      "html.duckduckgo": () => new Response("<html>redesigned</html>"),
      "bing.com": () => new Response("<rss></rss>"),
      "lite.duckduckgo": () => new Response(lite),
    });
    const result = await createWebSearchTool({ fetchImpl: impl })!.execute({ query: "q" }, ctx);

    expect(dialled.some((u) => u.includes("lite.duckduckgo"))).toBe(true);
    expect(result.content).toContain("https://lite.example/");
  });
});

describe("which sources a search asks, as the model says", () => {
  const dialledFor = async (args: Record<string, unknown>) => {
    const { impl, dialled } = sources();
    const result = await createWebSearchTool({ fetchImpl: impl })!.execute(args, ctx);
    return { dialled: dialled.join("\n"), result };
  };
  const DEV = ["api.github.com", "hn.algolia.com", "api.stackexchange.com", "registry.npmjs.org", "developer.mozilla.org"];

  test("by default: web, news, wiki and forum — no developer sources, no papers", async () => {
    const { dialled } = await dialledFor({ query: "bun sqlite wal error" });
    for (const host of DEV) expect(dialled).not.toContain(host);
    expect(dialled).not.toContain("arxiv.org");
    for (const host of ["html.duckduckgo", "bing.com", "news.google.com", "en.wikipedia.org", "site%3Areddit.com"]) expect(dialled).toContain(host);
  });

  test('"code" adds the developer sources, "papers" adds arXiv with every word required', async () => {
    const code = await dialledFor({ query: "bun sqlite wal error", sources: ["web", "code"] });
    for (const host of DEV) expect(code.dialled).toContain(host);
    expect(code.dialled).not.toContain("news.google.com");

    const papers = await dialledFor({ query: "retrieval augmented generation survey", sources: ["papers"] });
    expect(papers.dialled).toContain("export.arxiv.org");
    expect(decodeURIComponent(papers.dialled)).toContain("all:retrieval AND all:augmented");
    expect(papers.dialled).not.toContain("duckduckgo");
  });

  test("lang picks the news edition and adds that language's Wikipedia, for any language", async () => {
    const id = await dialledFor({ query: "harga emas antam", lang: "id" });
    expect(id.dialled).toContain("id.wikipedia.org");
    expect(id.dialled).toContain("en.wikipedia.org");
    expect(id.dialled).toContain("ceid=ID:id");

    const ja = await dialledFor({ query: "ビットコイン", lang: "ja" });
    expect(ja.dialled).toContain("ja.wikipedia.org");
    expect(ja.dialled).toContain("ceid=JP:ja");

    const en = await dialledFor({ query: "gold price" });
    expect(en.dialled.match(/wikipedia\.org/g)?.length).toBe(1);
    expect(en.dialled).toContain("ceid=US:en");
  });

  test("news editions: the exact tag, the language's usual one, then English", () => {
    expect(newsEdition("pt-BR").ceid).toBe("BR:pt-419");
    expect(newsEdition("pt").ceid).toBe("BR:pt-419");
    expect(newsEdition("pt-pt").ceid).toBe("PT:pt-150");
    expect(newsEdition("zh").ceid).toBe("CN:zh-Hans");
    expect(newsEdition("zh-TW").ceid).toBe("TW:zh-Hant");
    expect(newsEdition("es-AR").ceid).toBe("MX:es-419");
    expect(newsEdition("es").ceid).toBe("ES:es");
    expect(newsEdition("en-GB").ceid).toBe("GB:en");
    expect(newsEdition("ms").ceid).toBe("US:en");
    expect(newsEdition("sw").ceid).toBe("US:en");
  });

  test("a source kind that does not exist is refused, naming the ones that do", async () => {
    const { result } = await dialledFor({ query: "q", sources: ["web", "tiktok"] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("web, news, code, papers, wiki, forum");
    expect((await dialledFor({ query: "q", lang: "french please" })).result.content).toContain("language tag");
  });
});

describe("news", () => {
  const RSS =
    "<rss><channel><title>feed</title><link>https://news.google.com/search</link>" +
    "<item><title>Harga Emas Antam Turun - detikFinance</title><link>https://news.google.com/rss/articles/abc?oc=5</link>" +
    "<pubDate>Tue, 06 Oct 2026 03:00:00 GMT</pubDate><source url=\"https://finance.detik.com\">detikFinance</source></item></channel></rss>";

  test("headline, publisher and date, and how to read the article", () => {
    const [hit] = extractResults(RSS, provider("google-news"));
    expect(hit!.title).toBe("Harga Emas Antam Turun - detikFinance (Google News)");
    expect(hit!.url).toBe("https://news.google.com/rss/articles/abc?oc=5");
    expect(hit!.snippet).toContain("detikFinance · 2026-10-06");
    expect(hit!.snippet).toContain("search the headline");
  });

  test("leads the list when the answer is recent, follows the web otherwise", async () => {
    const { impl } = sources({ "news.google.com": () => new Response(RSS) });
    const tool = createWebSearchTool({ fetchImpl: impl })!;

    const current = (await tool.execute({ query: "harga emas antam hari ini", recent: true }, ctx)).content;
    expect(current.indexOf("Google News")).toBeLessThan(current.indexOf("https://bun.sh/"));

    const evergreen = (await tool.execute({ query: "harga emas antam" }, ctx)).content;
    expect(evergreen).toContain("Google News");
    expect(evergreen.indexOf("https://bun.sh/")).toBeLessThan(evergreen.indexOf("Google News"));
  });
});

describe("the other JSON and feed sources", () => {
  test("npm, MDN and arXiv answers become results", () => {
    expect(extractResults(JSON.stringify({ objects: [{ downloads: { weekly: 1234 }, package: { name: "sqlite", version: "5.1.1", description: "SQLite client", links: { npm: "https://www.npmjs.com/package/sqlite" } } }] }), provider("npm"))).toEqual([
      { title: "sqlite@5.1.1 (npm)", url: "https://www.npmjs.com/package/sqlite", snippet: "SQLite client · 1,234 weekly downloads" },
    ]);
    expect(extractResults(JSON.stringify({ documents: [{ mdn_url: "/en-US/docs/Web/API/AbortController", title: "AbortController", summary: "Aborts." }] }), provider("mdn"))).toEqual([
      { title: "AbortController (MDN)", url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController", snippet: "Aborts." },
    ]);
    const atom =
      '<feed><entry><id>http://arxiv.org/abs/1</id><published>2025-04-18T00:00:00Z</published><title>RAG\n  Survey</title>' +
      '<link href="https://arxiv.org/abs/1v1" rel="alternate" type="text/html"/><summary>Short abstract.</summary></entry></feed>';
    expect(extractResults(atom, provider("arxiv"))).toEqual([
      { title: "RAG Survey (arXiv)", url: "https://arxiv.org/abs/1v1", snippet: "2025-04-18 · Short abstract." },
    ]);
  });
});

describe("an engine that answers with someone else's results", () => {
  // What Bing sent on 2026-10-06 to a query about AbortController.
  const poisoned =
    "<rss><item><title>Dxdiag - Windows 10 Forums</title><link>https://forums.example/dxdiag</link></item>" +
    "<item><title>Active Directory hizmetleri</title><link>https://forums.example/ad</link></item>" +
    "<item><title>OpenAI · GitHub</title><link>https://github.com/openai</link></item></rss>";

  test("is left out whole when none of its results mention the query", async () => {
    const { impl } = sources({ "bing.com": () => new Response(poisoned) });
    const result = await createWebSearchTool({ fetchImpl: impl })!.execute({ query: "abortcontroller fetch timeout" }, ctx);

    expect(result.content).toContain("https://bun.sh/");
    expect(result.content).not.toContain("Dxdiag");
    expect(result.metadata?.source).not.toContain("bing");
  });

  test("judged on the whole answer: one result on topic keeps the rest, as a cross-language answer needs", () => {
    const hit = (title: string, url = "https://x.example/") => ({ title, url, snippet: "" });
    const offTopic = [hit("Dxdiag"), hit("Canva tips"), hit("OpenAI")];
    expect(looksPoisoned(offTopic, "abortcontroller fetch timeout")).toBe(true);
    expect(looksPoisoned([...offTopic, hit("Untitled", "https://x.example/abortcontroller")], "abortcontroller fetch timeout")).toBe(false);
    // Too few to judge, and a query with no word long enough to check: let through.
    expect(looksPoisoned(offTopic.slice(0, 2), "abortcontroller")).toBe(false);
    expect(looksPoisoned(offTopic, "go ai")).toBe(false);
  });
});
