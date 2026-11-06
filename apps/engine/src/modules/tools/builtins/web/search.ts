/**
 * `web_search`: which service answers, and what happens when it does not.
 *
 * The chain is the whole design. A configured backend, then whatever `fallback_backends` names, tried
 * in order — but only past a *transient* failure, because a 401 answered from a scraper instead would
 * hide the thing the operator has to fix. What each service speaks lives in `search-backends.ts`; this
 * file only knows it has an endpoint, some headers, and something that turns a body into results.
 */

import type { Tool } from "@nouride/shared";
import {
  resolveSearch,
  SEARCH_BACKENDS,
  type ImageResult,
  type SearchBackend,
  type SearchKind,
  type SearchResult,
} from "@/modules/tools/builtins/search-backends.ts";
import { KEYLESS_PROVIDERS } from "@/modules/tools/builtins/keyless-sources.ts";
import { DEFAULT_SEARCH_INTENT, SEARCH_GROUPS, type SearchGroup, type SearchIntent } from "@/modules/tools/builtins/keyless-types.ts";
import { searchKeyless } from "@/modules/tools/builtins/web/keyless-search.ts";
import { untilAborted } from "@/commons/abort.ts";
import { log, SNIPPETS_ARE_NOT_PAGES, UNTRUSTED_PREFIX, type WebToolOptions } from "@/modules/tools/builtins/web/shared.ts";
import { combineSearches, MAX_BATCH_QUERIES, parseQueries, type QueryOutcome } from "@/modules/tools/builtins/web/search-batch.ts";

const MAX_SEARCH_RESULTS = 8;

/**
 * How long an API backend may take. Past it the call is a timeout — transient — so the fallback chain
 * answers instead of the turn waiting on a socket that may never close.
 */
const SEARCH_TIMEOUT_MS = 10_000;

/** What a backend answered with: results, or the reason it could not. */
type SearchOutcome =
  | {
      hits: SearchResult[];
      source?: string;
      /** Backends that failed before one answered, in order. Empty on a clean primary hit. */
      warnings?: string[];
    }
  | { error: string };

/** What `resolveSearch` hands back when a backend is configured. */
type ResolvedSearch = {
  backend: SearchBackend;
  kind: SearchKind;
  endpoint: string;
  fallbackEnabled: boolean;
  fallbackBackends: string[];
};

/** One link in the chain: something that can answer a query, and a name to blame when it does not. */
interface SearchAttempt {
  name: string;
  run: () => Promise<SearchOutcome>;
}

/**
 * The configured backend, then whatever `fallback_backends` names, in order.
 *
 * A real chain rather than the one hardcoded name it started as. The first version compared each
 * entry against the literal string `"duckduckgo"` and `continue`d past anything else — so
 * `fallback_backends = ["searxng", "duckduckgo"]` was accepted by the config, printed back by the
 * dashboard, and searxng was never tried. A config surface that takes a value and ignores it is worse
 * than one that does not offer it.
 *
 * `duckduckgo` is the keyless scraping chain, which is why it is not a `search_kind`: no endpoint, no
 * credential. The other two reuse this section's endpoint and key, so one with nothing to authenticate
 * with is dropped from the chain here and reported by `nouride doctor` — trying it would spend a
 * round-trip to earn a 401.
 */
function buildChain(
  resolved: ResolvedSearch,
  query: string,
  intent: SearchIntent,
  doFetch: typeof fetch,
  apiKey: string | undefined,
): SearchAttempt[] {
  const chain: SearchAttempt[] = [
    {
      name: resolved.kind,
      run: () => callBackend(resolved.backend, resolved.endpoint, query, doFetch, apiKey),
    },
  ];

  if (!resolved.fallbackEnabled) return chain;

  for (const name of resolved.fallbackBackends) {
    if (name === "duckduckgo") {
      chain.push({ name: "duckduckgo", run: () => searchKeyless(KEYLESS_PROVIDERS, query, intent, doFetch) });
      continue;
    }
    const backend = SEARCH_BACKENDS[name as SearchKind];
    if (!backend) continue; // Reported by `lintConfig`, not swallowed here.
    if (name === resolved.kind) continue; // Already the primary.

    /**
     * Its own default endpoint, never the primary's.
     *
     * `search_endpoint` belongs to the configured `search_kind` — a SearXNG URL is not a Brave URL,
     * and handing one to the other buys a 404 that reads as the fallback being broken. Which means a
     * backend with no public default (SearXNG) cannot serve as a fallback at all while there is only
     * one endpoint field to configure, and one that needs a credential cannot serve without one.
     * Both are dropped here and reported by `lintConfig`, rather than dialled to earn a 404 or a 401.
     */
    if (!backend.defaultEndpoint) continue;
    if (backend.requiresApiKey && !apiKey) continue;
    const endpoint = backend.defaultEndpoint;
    chain.push({ name, run: () => callBackend(backend, endpoint, query, doFetch, apiKey) });
  }

  return chain;
}

/** One HTTP call to one API backend. */
async function callBackend(
  backend: SearchBackend,
  endpoint: string,
  query: string,
  doFetch: typeof fetch,
  apiKey: string | undefined,
): Promise<SearchOutcome> {
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const res = await untilAborted(
    doFetch(backend.buildUrl(endpoint, query, MAX_SEARCH_RESULTS), { headers: backend.headers(apiKey), signal }),
    signal,
  );

  if (!res.ok) return { error: `HTTP ${res.status}` };

  // A self-hosted instance answering HTML — the usual sign that its `json` format is off — fails here.
  // Reported as a content-type problem rather than a bare parse error, because the fix is one line in
  // someone's settings file and nothing else would point at it.
  const body = await res.json().catch(() => null);
  if (body === null) {
    return { error: "the endpoint did not answer with JSON (if this is SearXNG, add `json` to `search.formats`)" };
  }
  return { hits: backend.parse(body).slice(0, MAX_SEARCH_RESULTS) };
}

/**
 * Run the chain until something answers, and say what it took.
 *
 * Only *transient* failures move down the chain. A 401 or a 404 is a configuration mistake, and
 * quietly answering from a scraper instead would hide the thing the operator has to fix — they would
 * see results, believe the endpoint works, and never learn the key is wrong.
 *
 * Every failure is kept and returned. The previous version threw the primary's error away on the way
 * to the fallback and rethrew a raw network error when the fallback came up empty, so "all backends
 * failed" arrived as one provider's stack trace.
 */
async function searchBackend(
  resolved: ResolvedSearch,
  query: string,
  intent: SearchIntent,
  doFetch: typeof fetch,
  apiKey: string | undefined,
): Promise<SearchOutcome> {
  const chain = buildChain(resolved, query, intent, doFetch, apiKey);
  /**
   * Kept apart, because they mean opposite things at the end of the chain.
   *
   * "Found nothing" is a legitimate answer to an obscure query — every backend agreeing on it is
   * still an answer, and reporting an error would send the agent looking for a fault. "Failed" is not
   * an answer at all. So an empty result set at the end is only an error if something along the way
   * actually broke.
   */
  const failures: string[] = [];
  const empties: string[] = [];

  for (const [index, attempt] of chain.entries()) {
    const isLast = index === chain.length - 1;
    let outcome: SearchOutcome;
    try {
      outcome = await attempt.run();
    } catch (err) {
      outcome = { error: String(err) };
    }

    if (!("error" in outcome)) {
      const notes = [...failures, ...empties];
      if (outcome.hits.length > 0 || (isLast && failures.length === 0)) {
        return {
          ...outcome,
          // Prefixed so one field says both which source answered and that it was not the primary —
          // the audit line and the log stay self-describing without a second field to join against.
          ...(index > 0 ? { source: `fallback:${outcome.source ?? attempt.name}` } : {}),
          ...(notes.length > 0 ? { warnings: notes } : {}),
        };
      }
      // Answered, but with nothing. Worth trying the next backend rather than reporting "no results"
      // from an endpoint that may simply be misconfigured.
      empties.push(`${attempt.name} returned no results`);
      continue;
    }

    failures.push(`${attempt.name} failed (${outcome.error})`);
    log.warn("search backend failed", { backend: attempt.name, error: outcome.error });

    // A permanent failure stops the chain: see above on why a wrong key must not be papered over.
    if (index === 0 && !isTransientError(outcome.error)) break;
  }

  const notes = [...failures, ...empties];
  return {
    error:
      notes.length === 1
        ? `Search failed: ${notes[0]}`
        : `Search failed. Every backend was tried:\n${notes.map((note) => `- ${note}`).join("\n")}`,
  };
}

/** Worth trying somewhere else, as opposed to worth telling the operator about. */
function isTransientError(error: string): boolean {
  const status = /^HTTP (\d{3})$/.exec(error)?.[1];
  if (status) {
    const code = Number(status);
    return code === 429 || code >= 500;
  }
  // Anything that is not an HTTP status is a socket problem, a DNS failure or a timeout.
  return !/did not answer with JSON/.test(error);
}

/**
 * Image search, when the configured backend has it.
 *
 * The refusal when it does not is the important half. A backend without images could be made to run
 * a *web* search and return page URLs, which would look like it worked and hand the agent HTML
 * documents to send as pictures. Naming the two settings that would fix it is the honest answer, and
 * the one an operator can act on (invariant 5).
 */
async function searchImages(
  resolved: { backend: SearchBackend; endpoint: string; fallbackEnabled: boolean; fallbackBackends: string[] },
  query: string,
  doFetch: typeof fetch,
  apiKey: string | undefined,
): Promise<{ hits: ImageResult[] } | { error: string }> {
  const { backend, endpoint } = resolved;
  if (!backend.images) {
    return {
      error:
        "Image search is not available with the configured search backend. " +
        'Set `[security.web] search_api_key` for Brave, or `search_kind = "searxng"` with a ' +
        "`search_endpoint`. Web search still works.",
    };
  }

  const target = backend.images.endpointFor(endpoint);
  const res = await doFetch(backend.images.buildUrl(target, query, MAX_SEARCH_RESULTS), {
    headers: backend.headers(apiKey),
  });
  if (!res.ok) {
    const isTransient = res.status === 429 || res.status >= 500;
    return {
      error: isTransient
        ? `Image search failed: HTTP ${res.status} (the backend may be temporarily unavailable, so try again shortly)`
        : `Image search failed: HTTP ${res.status}`,
    };
  }

  const body = await res.json().catch(() => null);
  if (body === null) {
    return {
      error:
        "Image search failed: the endpoint did not answer with JSON. If this is SearXNG, add `json` to `search.formats`.",
    };
  }
  return { hits: backend.images.parse(body).slice(0, MAX_SEARCH_RESULTS) };
}

/**
 * `web_search`, or `null` when no backend is configured.
 *
 * Returning null rather than a tool that always errors: a tool in the schema is a promise
 * to the model that it can be used, and one that fails every time wastes a tool iteration
 * and confuses the turn.
 *
 * Which service answers is decided once, here. `execute` knows only that it has an endpoint, some
 * headers and something that turns a body into results — so adding a service never edits this
 * function. See `search-backends.ts`, including how to run SearXNG instead of Brave.
 */
export function createWebSearchTool(options: WebToolOptions = {}): Tool | null {
  const resolved = resolveSearch({
    kind: options.searchKind ?? "brave",
    endpoint: options.searchEndpoint,
    apiKey: options.searchApiKey,
    fallbackEnabled: options.fallbackEnabled,
    fallbackBackends: options.fallbackBackends,
  });
  if ("unavailable" in resolved) {
    log.info("web_search not offered", { reason: resolved.unavailable });
    return null;
  }

  const keyless = "keyless" in resolved ? resolved.keyless : null;
  if (keyless) {
    // Said out loud at boot. Scraping search pages is brittle by nature — rate limited, and one markup
    // change per source from returning nothing — so an operator should know they are on it and that a
    // key would be better, rather than discovering it the day results go quiet.
    log.info("web_search is using the keyless fallback", {
      sources: keyless.map((p) => p.name),
      hint: 'set [security.web] search_api_key for Brave, or search_kind = "searxng" with an endpoint',
    });
  }
  const doFetch = options.fetchImpl ?? fetch;

  const tool: Tool = {
    requiresApproval: false,
    // Fetching a URL cannot interfere with fetching another. Four pages at once is the point.
    parallelSafe: true,
    definition: {
      name: "web_search",
      description:
        "Search the web and return titles, URLs and snippets. " +
        // Known now, so the description says which: offering pictures on the keyless chain would be a
        // promise every image call breaks.
        (keyless
          ? 'Image search (`kind: "image"`) is not available on this install: it uses the keyless web search.'
          : 'Set `kind: "image"` to search for pictures instead: that returns direct image URLs, which ' +
            "`send_file` can take with its `url` parameter to put the picture in the conversation."),
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          queries: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_BATCH_QUERIES,
            description:
              `Several searches run at the same time in one call (up to ${MAX_BATCH_QUERIES}): different angles on ` +
              "one question, or the separate things a question needs. Use this or `query`, not both.",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: SEARCH_GROUPS },
            description:
              'Kinds of source to ask (default web, news, wiki, forum). "code": GitHub, Stack Overflow, npm, MDN, HN. ' +
              '"papers": arXiv. "forum": Reddit. Keep "web" unless you want only the others.',
          },
          lang: {
            type: "string",
            description: 'Language tag of the answer wanted, usually the person\'s: "en" (default), "id", "ja", "pt-BR".',
          },
          recent: {
            type: "boolean",
            description: "The answer depends on recent events (today's price, news): headlines first.",
          },
          kind: {
            type: "string",
            enum: ["web", "image"],
            description: 'Defaults to "web". Use "image" when the answer is a picture.',
          },
        },
      },
    },

    async execute(args) {
      const targets = parseQueries(args.query, args.queries);
      if (typeof targets === "string") return { content: targets, isError: true };
      const intent = parseIntent(args.sources, args.lang, args.recent);
      if (typeof intent === "string") return { content: intent, isError: true };
      const searchOne = (q: string) => searchOneWith(q, intent);
      if (targets.batch) {
        if (args.kind === "image") return { content: "Image search takes one `query`, not `queries`.", isError: true };
        return combineSearches(targets.queries, await Promise.all(targets.queries.map(searchOne)));
      }
      const query = targets.queries[0]!;

      if (args.kind === "image") {
        // The keyless chain scrapes result *pages* and has no image mode. Substituting a web search
        // would hand back page URLs that are not images — the silent wrong answer this refuses.
        if (keyless) {
          return {
            content:
              "Image search is not configured on this daemon: it is on the keyless web search. Tell the " +
              "person, and that the operator can enable it with `[security.web] search_api_key` (Brave) " +
              'or `search_kind = "searxng"` with a `search_endpoint`. Web search still works.',
            isError: true,
          };
        }

        const images = await searchImages(
          resolved as { backend: SearchBackend; endpoint: string; fallbackEnabled: boolean; fallbackBackends: string[] },
          query,
          doFetch,
          options.searchApiKey,
        );
        if ("error" in images) return { content: images.error, isError: true };
        if (images.hits.length === 0) return { content: "No images found.", isError: false };

        const rendered = images.hits
          .map((r, i) => {
            const size = r.width && r.height ? ` (${r.width}\u00d7${r.height})` : "";
            return `${i + 1}. ${r.title || "(untitled)"}${size}\n   image: ${r.imageUrl}\n   found on: ${r.sourceUrl}`;
          })
          .join("\n\n");

        return {
          content:
            `${UNTRUSTED_PREFIX}\n\nImages for "${query}":\n\n${rendered}\n\n` +
            "To send one, pass the `image:` URL to `send_file` as its `url`, not the `found on:` page, " +
            "which is HTML, and not through `curl` first: a shell download exits 0 on a Cloudflare " +
            "check and leaves you sending the challenge page as the picture.",
          isError: false,
          untrusted: true,
          metadata: { count: images.hits.length, kind: "image" },
        };
      }

      const one = await searchOne(query);
      if (!one.ok) return { content: one.error, isError: true };
      // Nothing found is a plain sentence, as it always was: there is no fetched text to mark untrusted.
      if (one.metadata.count === 0) return { content: one.text, isError: false };
      return { content: `${UNTRUSTED_PREFIX}\n\n${one.text}\n\n${SNIPPETS_ARE_NOT_PAGES}`, isError: false, untrusted: true, metadata: one.metadata };
    },
  };

  /** One web search, start to finish. Never throws: a batch reports each query beside the others. */
  async function searchOneWith(query: string, intent: SearchIntent): Promise<QueryOutcome> {
    try {
      const results = keyless
        ? await searchKeyless(keyless, query, intent, doFetch)
        : await searchBackend(resolved as ResolvedSearch, query, intent, doFetch, options.searchApiKey);

      if ("error" in results) return { ok: false, error: results.error };
      if (results.hits.length === 0) return { ok: true, text: "No results.", metadata: { count: 0 } };

      const rendered = results.hits
        .map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}\n   ${stripTags(r.snippet)}`)
        .join("\n\n");

      /**
       * Said in the content, not just the metadata.
       *
       * Only `content` reaches the model — metadata is for the audit trail — so a fallback recorded
       * there alone was invisible to the one reader who should adjust for it. Results scraped off a
       * result page are thinner and ranked differently than an API's, and an agent that cannot tell
       * reports them with the same confidence either way.
       */
      const degraded =
        results.warnings && results.warnings.length > 0
          ? `\n\n[fallback: answered by ${results.source ?? "a fallback backend"} (${results.warnings.join("; ")}). Results may be thinner than usual.]`
          : "";

      return {
        ok: true,
        text: `Results for "${query}":\n\n${rendered}${degraded}`,
        metadata: {
          count: results.hits.length,
          ...(results.source ? { source: results.source } : {}),
          ...(results.warnings?.length ? { fallbackApplied: true, warnings: results.warnings } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: `Search failed: ${String(err)}` };
    }
  }

  return tool;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

/** `sources`, `lang` and `recent`, or a sentence saying what is wrong with them. */
function parseIntent(sources: unknown, lang: unknown, recent: unknown): SearchIntent | string {
  let groups = DEFAULT_SEARCH_INTENT.groups;
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.some((s) => !SEARCH_GROUPS.includes(s as SearchGroup)) || sources.length === 0) {
      return `\`sources\` takes a non-empty list of: ${SEARCH_GROUPS.join(", ")}.`;
    }
    groups = [...new Set(sources as SearchGroup[])];
  }
  if (lang !== undefined && (typeof lang !== "string" || !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(lang))) {
    return '`lang` is a language tag such as "en", "id", "ja" or "pt-BR".';
  }
  return { groups, lang: (lang as string | undefined) ?? DEFAULT_SEARCH_INTENT.lang, recent: recent === true };
}
