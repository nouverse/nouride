/**
 * Turning a keyless source's answer into results, and telling when that answer is not about the
 * question at all.
 */

import type { SearchResult } from "@/modules/tools/builtins/search-backends.ts";
import { DEFAULT_SEARCH_INTENT, type KeylessProvider, type SearchIntent } from "@/modules/tools/builtins/keyless-types.ts";

/**
 * Pull results out of a page, or out of a JSON answer for the sources that have one.
 *
 * Deliberately loose: it finds the result anchors and the snippets that follow them, and gives up on
 * anything it does not recognise rather than trying to model the document. A layout change should
 * cost results, never an exception — and so should a JSON source answering HTML (a rate-limit page,
 * a captcha).
 */
export function extractResults(
  body: string,
  provider: KeylessProvider,
  intent: SearchIntent = DEFAULT_SEARCH_INTENT,
): SearchResult[] {
  const results = provider.parse
    ? parseJson(body, (json) => provider.parse!(json, intent))
    : provider.parseText
      ? provider.parseText(body, intent)
      : scrape(body, provider);
  const kept = provider.keep ? results.filter((r) => provider.keep!(r.url)) : results;
  return kept
    .map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.snippet) }))
    .filter((r) => r.title && /^https?:\/\//.test(r.url))
    .slice(0, provider.maxResults ?? Number.POSITIVE_INFINITY);
}

function parseJson(body: string, parse: (body: unknown) => SearchResult[]): SearchResult[] {
  try {
    return parse(JSON.parse(body));
  } catch {
    return [];
  }
}

function scrape(html: string, provider: KeylessProvider): SearchResult[] {
  if (!provider.linkPattern) return [];
  const snippets = provider.snippetPattern
    ? [...html.matchAll(provider.snippetPattern)].map((m) => stripTags(m[1] ?? ""))
    : [];

  const results: SearchResult[] = [];
  for (const match of html.matchAll(provider.linkPattern)) {
    // Bing's RSS puts the title first and the link second; the HTML sources are the other way round.
    // Detected by shape rather than by name, so a new source needs no special case here.
    const first = match[1] ?? "";
    const second = match[2] ?? "";
    const looksLikeUrl = (value: string) => /^(https?:|\/\/)/.test(value.trim());
    const rawUrl = looksLikeUrl(first) ? first : looksLikeUrl(second) ? second : "";
    const title = stripTags(rawUrl === first ? second : first);

    const url = decodeRedirect(stripTags(rawUrl));
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippets[results.length] ?? "" });
  }
  return results;
}

export function stripTags(html: string): string {
  return html
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Unwrap the interstitial some engines wrap results in.
 *
 * `//duckduckgo.com/l/?uddg=<encoded>` is a redirect, and handing the model that URL means the next
 * `web_fetch` reads a tracker instead of the page it asked for.
 */
function decodeRedirect(href: string): string {
  const match = /[?&](?:uddg|u|url)=([^&]+)/.exec(href);
  if (match?.[1]) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (/^https?:/.test(decoded)) return decoded;
    } catch {
      // Fall through to the raw href: a link we cannot decode is better than no link.
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Whether an engine answered with someone else's results: several of them (`minimum`, lower for a
 * source capped below it), and not one mentioning
 * any word of the query (three letters or more) in its title, snippet or URL.
 *
 * Because an engine that has decided we are a bot does not always refuse. Bing, probed on
 * 2026-10-06, answered "AbortController fetch timeout" with Windows forum threads and Zhihu posts —
 * a 200, well-formed, nothing to do with the question, and the same with a browser user agent.
 *
 * Judged on the whole answer, never per result: a query in Indonesian answered by an English page is
 * a good result with no word in common, and dropping those one by one would cost real answers. A
 * poisoned answer has *none*, which a real one practically never does.
 */
export function looksPoisoned(hits: SearchResult[], query: string, minimum = 3): boolean {
  if (hits.length < minimum) return false;
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (words.length === 0) return false;
  return !hits.some((hit) => {
    let haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
    try {
      haystack += ` ${decodeURIComponent(hit.url).toLowerCase()}`;
    } catch {
      // A URL that does not decode is checked as it is.
    }
    return words.some((w) => haystack.includes(w));
  });
}

/** Words every page has, which would make anything look relevant. */
const STOPWORDS = new Set(["the", "and", "for", "with", "how", "what", "why", "yang", "dan", "untuk", "dengan", "ini", "itu", "apa", "cara"]);
