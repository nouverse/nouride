/**
 * Where `web_search` gets its results from.
 *
 * One shape, several services. The tool was written against Brave — its endpoint, its auth header and
 * its response nesting were spread through `execute`, so using anything else meant editing the tool.
 * That is the same "branch on a vendor inside shared code" this codebase refuses everywhere else
 * (invariant 2): the *kind* selects an implementation, and nothing downstream asks which service
 * answered.
 *
 * Adding one is three functions, a row in `SEARCH_BACKENDS` and its name in `SEARCH_KINDS`, plus a
 * `body` when the service is searched with a POST (Exa). It deliberately does not try to be a plugin
 * system — a search API is a URL, a header and a JSON path, and an abstraction bigger than that would
 * be larger than the thing it abstracts.
 *
 * ## Using SearXNG instead of Brave
 *
 * SearXNG is self-hosted and needs no key, which makes it the free option. Add it beside the daemon:
 *
 * ```yaml
 * # docker-compose.yml
 * searxng:
 *   image: searxng/searxng
 *   environment:
 *     - SEARXNG_BASE_URL=http://searxng:8080/
 *   volumes:
 *     - ./searxng:/etc/searxng
 * ```
 *
 * Then point the daemon at it:
 *
 * ```toml
 * [security.web]
 * search_kind = "searxng"
 * search_endpoint = "http://searxng:8080/search"
 * # No search_api_key: SearXNG does not use one.
 * # It is on a private address, so the SSRF guard must be told this one is expected:
 * allow_private_urls = true
 * ```
 *
 * Two things a fresh SearXNG will trip on, both in its own `settings.yml`:
 *
 * - **The JSON format is off by default.** Add `json` to `search.formats`, or every request comes back
 *   as HTML and this reports a parse failure rather than a configuration one.
 * - **A limiter is on by default** on some images and will answer 429 to a server-side caller. Turn it
 *   off for a private instance, or the tool works for a minute and then stops.
 */

import { KEYLESS_PROVIDERS } from "@/modules/tools/builtins/keyless-sources.ts";
import type { KeylessProvider } from "@/modules/tools/builtins/keyless-types.ts";

/**
 * The backends an operator can *choose*. Each wants a key or an endpoint.
 *
 * The keyless chain (`keyless-sources.ts`) is deliberately not one of these: it is what happens when nothing is
 * configured, not something to configure. The one list the loader, the schema and the fallback chain all read, so a
 * service added here is accepted everywhere at once.
 */
export const SEARCH_KINDS = ["brave", "searxng", "exa"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * How much of each page Exa sends back with a result: a few sentences, about the length of a search snippet.
 *
 * Exa returns no snippet unless asked for page contents. Without one the agent has a title and a link and must open
 * every page to learn anything; the whole page per result would put eight pages into one tool answer.
 */
const EXA_HIGHLIGHT_CHARACTERS = 400;

/** What `[security.web] search_kind` means when nobody set it. */
const DEFAULT_SEARCH_KIND: SearchKind = "brave";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One image hit.
 *
 * `imageUrl` and `sourceUrl` are kept apart because they answer different questions and confusing
 * them produces the failure this whole feature exists to avoid: `sourceUrl` is a *page*, and handing
 * a page to something that expects an image sends an HTML document named `.jpg`.
 */
export interface ImageResult {
  title: string;
  /** The direct image file — what `send_file` needs. */
  imageUrl: string;
  /** The page it appeared on, so an agent can say where it came from. */
  sourceUrl: string;
  width?: number;
  height?: number;
}

/**
 * Image search, for the backends that have it.
 *
 * Optional on purpose. A backend that cannot do images says so by not having this, and the tool then
 * refuses by naming the two settings that would fix it — rather than running a *web* search and
 * returning page URLs, which look like results and are not images. That silent substitution is
 * exactly what invariant 5 forbids: a capability that appears to work and quietly did something else.
 */
export interface ImageSearch {
  /**
   * Where images live for this backend, derived from the configured web endpoint.
   *
   * Derived rather than configured separately: an operator who set one endpoint has said where their
   * instance is, and asking for a second one to describe the same server is a setting to get wrong.
   */
  endpointFor(endpoint: string): string;
  buildUrl(endpoint: string, query: string, limit: number): string;
  parse(body: unknown): ImageResult[];
}

export interface SearchBackend {
  /** Used when the operator sets a kind but no endpoint. Null means the endpoint is required. */
  defaultEndpoint: string | null;
  /** Whether a missing credential means the tool cannot work at all. */
  requiresApiKey: boolean;
  /**
   * The secret name this service's key is kept under when nothing names another: where the Web Search page stores
   * one, and where a fallback looks for its own. `search_api_key` is the primary's alone, and a key sent to another
   * service is a 401 at best and the primary's key handed to a stranger at worst.
   */
  keyName?: string;
  /** Query string for one search. */
  buildUrl(endpoint: string, query: string, limit: number): string;
  /**
   * The JSON body, for a service searched with a POST. Absent: a GET of `buildUrl`.
   *
   * Exa takes its query and its options in a body; the others take them in the URL. Which one is the backend's
   * answer, so the call site never asks which service it is talking to.
   */
  body?(query: string, limit: number): unknown;
  headers(apiKey: string | undefined): Record<string, string>;
  /** Pull results out of the parsed body. An unfamiliar shape yields an empty list, never a throw. */
  parse(body: unknown): SearchResult[];
  /** Absent when this backend cannot search images. See `ImageSearch`. */
  images?: ImageSearch;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const SEARCH_BACKENDS: Record<SearchKind, SearchBackend> = {
  brave: {
    defaultEndpoint: "https://api.search.brave.com/res/v1/web/search",
    requiresApiKey: true,
    keyName: "brave_search_api_key",
    buildUrl(endpoint, query, limit) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(limit));
      return url.toString();
    },
    headers(apiKey) {
      return { accept: "application/json", "x-subscription-token": apiKey ?? "" };
    },
    parse(body) {
      const results = (body as { web?: { results?: unknown } })?.web?.results;
      if (!Array.isArray(results)) return [];
      return results.map((entry) => {
        const r = entry as Record<string, unknown>;
        return { title: text(r.title), url: text(r.url), snippet: text(r.description) };
      });
    },
    images: {
      endpointFor(endpoint) {
        // The two endpoints differ by one path segment. Falling back to the documented default rather
        // than mangling an endpoint we do not recognise: an operator pointing at a proxy has a URL
        // shape we cannot guess at, and a wrong guess is a 404 that reads as "image search is broken".
        return endpoint.includes("/web/search")
          ? endpoint.replace("/web/search", "/images/search")
          : "https://api.search.brave.com/res/v1/images/search";
      },
      buildUrl(endpoint, query, limit) {
        const url = new URL(endpoint);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(limit));
        // Otherwise the default is whatever the account is set to, and an agent asked for a picture
        // should not be the thing that surfaces adult results into somebody's chat.
        url.searchParams.set("safesearch", "strict");
        return url.toString();
      },
      parse(body) {
        const results = (body as { results?: unknown })?.results;
        if (!Array.isArray(results)) return [];
        return results
          .map((entry) => {
            const r = entry as Record<string, unknown>;
            const properties = (r.properties ?? {}) as Record<string, unknown>;
            const thumbnail = (r.thumbnail ?? {}) as Record<string, unknown>;
            // `properties.url` is the full-size file; `thumbnail.src` is Brave's own cached copy and
            // the only one that is always present. Preferring the original and falling back keeps a
            // result usable rather than dropping it.
            const imageUrl = text(properties.url) || text(thumbnail.src);
            return {
              title: text(r.title),
              imageUrl,
              sourceUrl: text(r.url),
              ...(typeof properties.width === "number" ? { width: properties.width } : {}),
              ...(typeof properties.height === "number" ? { height: properties.height } : {}),
            };
          })
          .filter((r) => r.imageUrl);
      },
    },
  },

  searxng: {
    // No default: a self-hosted instance is wherever the operator put it, and guessing `localhost`
    // would produce a connection error rather than the "you have not configured this" that is true.
    defaultEndpoint: null,
    requiresApiKey: false,
    buildUrl(endpoint, query, limit) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      // Without this the instance answers HTML and the failure reads as a broken parser rather than a
      // missing `json` entry in its `search.formats`.
      url.searchParams.set("format", "json");
      // SearXNG paginates rather than taking a count, so the slice happens after parsing. Asking for
      // page one is the whole of the request.
      url.searchParams.set("pageno", "1");
      void limit;
      return url.toString();
    },
    headers(apiKey) {
      // Some deployments sit behind a proxy that wants a bearer token. Sent only when there is one, so
      // an ordinary instance is not handed an `Authorization: Bearer undefined`.
      return {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      };
    },
    parse(body) {
      const results = (body as { results?: unknown })?.results;
      if (!Array.isArray(results)) return [];
      return results.map((entry) => {
        const r = entry as Record<string, unknown>;
        return { title: text(r.title), url: text(r.url), snippet: text(r.content) };
      });
    },
    images: {
      // The same endpoint. SearXNG selects images with a query parameter rather than a path, which is
      // why this one is the identity and Brave's is not.
      endpointFor: (endpoint) => endpoint,
      buildUrl(endpoint, query, limit) {
        const url = new URL(endpoint);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", "images");
        url.searchParams.set("pageno", "1");
        // SearXNG has no count parameter; the slice happens after parsing, as it does for web.
        void limit;
        return url.toString();
      },
      parse(body) {
        const results = (body as { results?: unknown })?.results;
        if (!Array.isArray(results)) return [];
        return results
          .map((entry) => {
            const r = entry as Record<string, unknown>;
            // `img_src` is the file; `url` is the page it was found on. Some engines fill only
            // `thumbnail_src`, and a thumbnail is still an image — better than dropping the hit.
            const imageUrl = text(r.img_src) || text(r.thumbnail_src);
            const resolution = text(r.resolution).match(/^(\d+)\s*[x\u00d7]\s*(\d+)$/);
            return {
              title: text(r.title),
              imageUrl,
              sourceUrl: text(r.url),
              ...(resolution ? { width: Number(resolution[1]), height: Number(resolution[2]) } : {}),
            };
          })
          .filter((r) => r.imageUrl);
      },
    },
  },

  /**
   * Exa: a search API made for AI agents, with a key (https://docs.exa.ai/reference/search).
   *
   * No `images`: Exa returns pages, and an image search here would hand back page URLs, so it refuses instead, as the
   * tool does for any backend without one.
   */
  exa: {
    defaultEndpoint: "https://api.exa.ai/search",
    requiresApiKey: true,
    keyName: "exa_api_key",
    // Everything is in the body; the endpoint is the whole address.
    buildUrl: (endpoint) => endpoint,
    body(query, limit) {
      return { query, numResults: limit, contents: { highlights: { maxCharacters: EXA_HIGHLIGHT_CHARACTERS } } };
    },
    headers(apiKey) {
      return { accept: "application/json", "x-api-key": apiKey ?? "" };
    },
    parse(body) {
      const results = (body as { results?: unknown })?.results;
      if (!Array.isArray(results)) return [];
      return results.map((entry) => {
        const r = entry as Record<string, unknown>;
        const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [];
        // Highlights are page text with its line breaks and headings, and a result is one indented line in what the
        // tool returns: the breaks would read as the next result's lines.
        const snippet = (highlights.length > 0 ? highlights.join(" … ") : text(r.text) || text(r.summary)).replace(/\s+/g, " ").trim();
        return { title: text(r.title), url: text(r.url), snippet };
      });
    },
  },
};

export function isSearchKind(value: unknown): value is SearchKind {
  return (SEARCH_KINDS as readonly unknown[]).includes(value);
}

/**
 * The services in the fallback chain that need a key of their own, each with the secret name it is looked for under.
 *
 * Not the primary: it has `search_api_key`. Not one without a `keyName`: SearXNG is reached by address, and as a
 * fallback not at all (it has no public default).
 */
export function fallbackKeyNames(web: { searchKind: string; fallbackBackends: readonly string[] }): { kind: SearchKind; name: string }[] {
  return SEARCH_KINDS.flatMap((kind) => {
    const name = SEARCH_BACKENDS[kind].keyName;
    return name && kind !== web.searchKind && web.fallbackBackends?.includes(kind) ? [{ kind, name }] : [];
  });
}

/** Each fallback service's own key, resolved from its own name; one that resolves to nothing is left out. */
export function resolveFallbackKeys(
  web: { searchKind: string; fallbackBackends: readonly string[] },
  resolve: (name: string) => string | undefined,
): Partial<Record<SearchKind, string>> {
  const keys: Partial<Record<SearchKind, string>> = {};
  for (const { kind, name } of fallbackKeyNames(web)) {
    const value = resolve(name);
    if (value) keys[kind] = value;
  }
  return keys;
}

/**
 * The endpoint to call, or an explanation of why this is not configured.
 *
 * Resolved once when the tool is built rather than on every search: a tool that cannot work must not
 * be offered to the model at all, and that decision needs an answer before the first turn.
 */
export function resolveSearch(input: {
  kind: SearchKind;
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  fallbackEnabled?: boolean;
  fallbackBackends?: string[];
}):
  | {
      backend: SearchBackend;
      /** Which kind `backend` is. Carried so a chain can name the link that failed. */
      kind: SearchKind;
      endpoint: string;
      fallbackEnabled: boolean;
      fallbackBackends: string[];
    }
  /** Nothing configured: the keyless chain, tried in order. */
  | { keyless: KeylessProvider[] }
  /** Nothing that works: why, in the config file's words, and what is missing, for a page that asks for it (0.8.23). */
  | { unavailable: string; needs: "address" | "key" } {
  const backend = SEARCH_BACKENDS[input.kind];

  const endpoint = input.endpoint?.trim() || backend.defaultEndpoint;
  if (!endpoint) {
    return {
      unavailable: `[security.web] search_kind = "${input.kind}" needs a search_endpoint: it has no public default.`,
      needs: "address",
    };
  }
  // A custom endpoint means the operator has a proxy that handles authentication upstream.
  // Only enforce the key requirement when using the backend's own default endpoint.
  const hasCustomEndpoint = Boolean(input.endpoint?.trim());
  if (backend.requiresApiKey && !input.apiKey && !hasCustomEndpoint) {
    // Falls back rather than withdrawing the tool.
    //
    // "No search tool" does not make an agent stop searching — it makes it improvise. Observed live,
    // repeatedly: it wrote a `python3` scraper against this same DuckDuckGo endpoint and ran it
    // through `exec`, which is slower, needs an approval, and puts a hand-written parser inside a
    // shell command. A scraping fallback is a worse search than Brave and a much better one than
    // that.
    //
    // Only when the *default* backend is unconfigured. An operator who explicitly chose a backend and
    // forgot its key gets told so, because silently searching somewhere else is not what they asked
    // for.
    if (input.kind === DEFAULT_SEARCH_KIND) return { keyless: KEYLESS_PROVIDERS };
    return { unavailable: `no API key for the "${input.kind}" search backend`, needs: "key" };
  }

  return {
    backend,
    kind: input.kind,
    endpoint,
    fallbackEnabled: input.fallbackEnabled ?? true,
    fallbackBackends: input.fallbackBackends ?? ["duckduckgo"],
  };
}
