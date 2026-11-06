/**
 * The keyless search sources: where each is, and how its answer reads. What a source *is* lives in
 * `keyless-types.ts`; how they are asked together lives in `web/keyless-search.ts`.
 */

import type { SearchResult } from "@/modules/tools/builtins/search-backends.ts";
import { newsEdition, wikipediaEdition } from "@/modules/tools/builtins/keyless-editions.ts";
import { stripTags } from "@/modules/tools/builtins/keyless-extract.ts";
import type { KeylessProvider } from "@/modules/tools/builtins/keyless-types.ts";

/**
 * A plain, identifying user agent.
 *
 * Pretending to be a browser is what gets a scraper blocked, and none of these sources demand one.
 * GitHub's API refuses a request with no user agent at all.
 */
const KEYLESS_HEADERS = {
  accept: "text/html",
  "user-agent": "nouride/0.1 (+https://github.com/nouverse/nouride)",
};

const JSON_HEADERS = { ...KEYLESS_HEADERS, accept: "application/json" };

/** How many results each community source may contribute. Enough to be found, not enough to crowd. */
const COMMUNITY_RESULTS = 2;

const DDG_HTML_LINKS = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const DDG_HTML_SNIPPETS = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

export const KEYLESS_PROVIDERS: KeylessProvider[] = [
  {
    // First because it is the one that actually answers. Verified live: 10 results for a real query
    // while two of the others returned nothing.
    name: "duckduckgo-html",
    tier: "web",
    group: "web",
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    headers: KEYLESS_HEADERS,
    linkPattern: DDG_HTML_LINKS,
    snippetPattern: DDG_HTML_SNIPPETS,
  },
  {
    // A different index entirely, through the RSS view — markup meant to be parsed rather than
    // rendered, so it is the least likely to change under us. Verified live. Its feed also carries
    // links back to Bing's own result page, which are not results.
    name: "bing",
    tier: "web",
    group: "web",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`,
    headers: { ...KEYLESS_HEADERS, accept: "application/rss+xml, text/html" },
    linkPattern: /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/gi,
    snippetPattern: /<description>([\s\S]*?)<\/description>/gi,
    keep: (url) => !/^https?:\/\/(?:www\.)?bing\.com(?::\d+)?\/search/i.test(url),
    mayPoison: true,
  },
  {
    // The same service, different page, and it fails independently — which is the only reason to
    // carry a second source at all.
    //
    // Matched on the redirect in the href, not on a class: the lite page carries no class on its
    // result anchors at all. The first version of this looked for `result-link`, found nothing, and
    // returned zero results forever while looking like it had been tried — exactly the silent
    // failure this chain exists to survive. Caught by probing it against the live page.
    name: "duckduckgo-lite",
    tier: "backup",
    group: "web",
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    headers: KEYLESS_HEADERS,
    linkPattern: /<a[^>]*href="((?:\/\/)?duckduckgo\.com\/l\/\?uddg=[^"]+|\/\/duckduckgo\.com\/l\/\?uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    snippetPattern: /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi,
  },
  {
    // Repositories. The unauthenticated search API allows 10 a minute per address; past that it
    // answers 403 and simply contributes nothing. `stars:>=10` because a query GitHub knows nothing
    // about (a gold price, in Indonesian) otherwise still matches someone's empty homework repo.
    name: "github",
    tier: "community",
    group: "code",
    url: (q) =>
      `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} stars:>=10`)}&per_page=${COMMUNITY_RESULTS}`,
    headers: { ...JSON_HEADERS, accept: "application/vnd.github+json" },
    maxResults: COMMUNITY_RESULTS,
    parse: (body) =>
      items(body, "items").map((repo) => ({
        title: `${str(repo.full_name)} (★${Number(repo.stargazers_count) || 0}, GitHub)`,
        url: str(repo.html_url),
        snippet: str(repo.description),
      })),
  },
  {
    // Through DuckDuckGo's `site:` filter: Reddit's own search answers 403 without OAuth.
    name: "reddit",
    tier: "community",
    group: "forum",
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:reddit.com ${q}`)}`,
    headers: KEYLESS_HEADERS,
    linkPattern: DDG_HTML_LINKS,
    snippetPattern: DDG_HTML_SNIPPETS,
    // A thread or a subreddit, not reddit's front page — which `site:` returns for a query it has
    // nothing for.
    keep: (url) => /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/r\/[^/]+/i.test(url),
    // And when it has nothing at all, DuckDuckGo fills `site:reddit.com` with whatever is popular.
    mayPoison: true,
    maxResults: COMMUNITY_RESULTS,
  },
  {
    // Algolia's public index of Hacker News. A story with no link is a discussion: point at it.
    name: "hackernews",
    tier: "community",
    group: "code",
    url: (q) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${COMMUNITY_RESULTS}`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body) =>
      items(body, "hits").map((hit) => {
        const discussion = `https://news.ycombinator.com/item?id=${str(hit.objectID)}`;
        return {
          title: `${str(hit.title)} (Hacker News)`,
          url: str(hit.url) || discussion,
          snippet: `${Number(hit.points) || 0} points, ${Number(hit.num_comments) || 0} comments: ${discussion}`,
        };
      }),
  },
  {
    // 300 requests a day per address without a key — plenty for a personal daemon.
    name: "stackoverflow",
    tier: "community",
    group: "code",
    url: (q) =>
      `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(q)}&site=stackoverflow&order=desc&sort=relevance&pagesize=${COMMUNITY_RESULTS}`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body) =>
      items(body, "items").map((question) => ({
        title: `${str(question.title)} (Stack Overflow)`,
        url: str(question.link),
        snippet:
          `${Number(question.answer_count) || 0} answers, score ${Number(question.score) || 0}` +
          (question.is_answered ? ", answered" : "") +
          (Array.isArray(question.tags) ? ` · ${question.tags.slice(0, 5).join(", ")}` : ""),
      })),
  },
  {
    // Packages. Only for a technical query: npm will match a gold price to someone's package.
    name: "npm",
    tier: "community",
    group: "code",
    url: (q) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${COMMUNITY_RESULTS}`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body) =>
      items(body, "objects").map((hit) => {
        const pkg = (hit.package ?? {}) as Record<string, unknown>;
        const links = (pkg.links ?? {}) as Record<string, unknown>;
        const name = str(pkg.name);
        const downloads = Number((hit.downloads as Record<string, unknown> | undefined)?.weekly) || 0;
        return {
          title: `${name}@${str(pkg.version)} (npm)`,
          url: str(links.npm) || `https://www.npmjs.com/package/${name}`,
          snippet: `${str(pkg.description)}${downloads ? ` · ${downloads.toLocaleString("en-US")} weekly downloads` : ""}`,
        };
      }),
  },
  {
    // The web platform reference: what a fetch, a CSS property or a DOM method actually does.
    name: "mdn",
    tier: "community",
    group: "code",
    url: (q) => `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q)}&size=${COMMUNITY_RESULTS}&locale=en-US`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body) =>
      items(body, "documents").map((doc) => ({
        title: `${str(doc.title)} (MDN)`,
        url: `https://developer.mozilla.org${str(doc.mdn_url)}`,
        snippet: str(doc.summary),
      })),
  },
  {
    // Papers. Every word is required (`all:a AND all:b`): arXiv joins bare words with OR, which on a
    // three-word query matches a hundred thousand papers about any one of them.
    name: "arxiv",
    tier: "community",
    group: "papers",
    url: (q) => {
      const terms = q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}-]/gu, "")).filter(Boolean).slice(0, 8);
      return `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(terms.map((t) => `all:${t}`).join(" AND "))}&max_results=${COMMUNITY_RESULTS}&sortBy=relevance`;
    },
    headers: { ...KEYLESS_HEADERS, accept: "application/atom+xml" },
    maxResults: COMMUNITY_RESULTS,
    parseText: (body) =>
      [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
        const entry = m[1] ?? "";
        const published = /<published>(\d{4}-\d{2}-\d{2})/.exec(entry)?.[1];
        return {
          title: `${tag(entry, "title")} (arXiv)`,
          url: /<link[^>]*href="([^"]+)"[^>]*rel="alternate"/.exec(entry)?.[1] ?? tag(entry, "id"),
          snippet: `${published ? `${published} · ` : ""}${tag(entry, "summary").slice(0, 300)}`,
        };
      }),
  },
  {
    // The headline, the publisher and the date are the answer here. The link is a Google News
    // redirect that `web_fetch` cannot follow (it answers with a JavaScript page), which is why the
    // snippet says to search the headline to read the article itself.
    name: "google-news",
    tier: "news",
    group: "news",
    url: (q, intent) => {
      const { hl, gl, ceid } = newsEdition(intent.lang);
      return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
    },
    headers: { ...KEYLESS_HEADERS, accept: "application/rss+xml" },
    maxResults: 4,
    parseText: (body) =>
      [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
        const item = m[1] ?? "";
        const date = tag(item, "pubDate");
        const day = date ? new Date(date) : null;
        const when = day && !Number.isNaN(day.getTime()) ? day.toISOString().slice(0, 10) : "";
        return {
          title: `${tag(item, "title")} (Google News)`,
          url: tag(item, "link"),
          snippet: [tag(item, "source"), when, "news; to read it, search the headline or open the publisher's site"]
            .filter(Boolean)
            .join(" · "),
        };
      }),
  },
  {
    name: "wikipedia",
    tier: "community",
    group: "wiki",
    url: (q) =>
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${COMMUNITY_RESULTS}&srsearch=${encodeURIComponent(q)}`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body) => wikipediaResults(body, "en"),
  },
  {
    // The Wikipedia in the language the answer is wanted in, beside the English one: a question about
    // a place, a person or a law there is usually covered better in its own language.
    name: "wikipedia-local",
    tier: "community",
    group: "wiki",
    when: (intent) => wikipediaEdition(intent.lang) !== "en",
    url: (q, intent) =>
      `https://${wikipediaEdition(intent.lang)}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${COMMUNITY_RESULTS}&srsearch=${encodeURIComponent(q)}`,
    headers: JSON_HEADERS,
    maxResults: COMMUNITY_RESULTS,
    parse: (body, intent) => wikipediaResults(body, wikipediaEdition(intent.lang)),
  },
];

function wikipediaResults(body: unknown, edition: string): SearchResult[] {
  const query = (body as { query?: unknown } | null)?.query;
  return items(query, "search").map((page) => ({
    title: `${str(page.title)} (Wikipedia${edition === "en" ? "" : `, ${edition}`})`,
    url: `https://${edition}.wikipedia.org/wiki/${encodeURIComponent(str(page.title).replace(/ /g, "_"))}`,
    snippet: str(page.snippet),
  }));
}

/** The text of the first `<name>` element, CDATA and all. */
function tag(xml: string, name: string): string {
  return stripTags(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml)?.[1] ?? "");
}

/** The array at `key`, as records — or nothing, whatever shape the body actually had. */
function items(body: unknown, key: string): Record<string, unknown>[] {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
