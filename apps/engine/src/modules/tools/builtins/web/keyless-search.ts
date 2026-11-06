/**
 * The keyless sources, asked together: the fan-out, each source's deadline, and how their answers are
 * merged into one list. Which sources exist is `keyless-sources.ts`.
 */

import type { SearchResult } from "@/modules/tools/builtins/search-backends.ts";
import { extractResults, looksPoisoned } from "@/modules/tools/builtins/keyless-extract.ts";
import type { KeylessProvider, SearchIntent } from "@/modules/tools/builtins/keyless-types.ts";
import { log } from "@/modules/tools/builtins/web/shared.ts";
import { untilAborted } from "@/commons/abort.ts";
import { contained } from "@nouride/shared";

/** What the keyless sources answered with, together. */
export interface KeylessOutcome {
  hits: SearchResult[];
  source?: string;
  /** Never set here — every source is asked at once, so none is a fallback for another. */
  warnings?: string[];
}

/** How long one keyless source may take before it is left out. A hung socket must cost seconds. */
const KEYLESS_SOURCE_TIMEOUT_MS = 6_000;

/**
 * How long to keep waiting once a general engine has answered.
 *
 * Long enough for the community sources dialled in the same instant to land, short enough that the
 * slowest of eight never sets the pace of the search.
 */
const KEYLESS_GRACE_MS = 1_200;

/** More than an API answer, because these come from several sources and are thinner each. */
const MAX_KEYLESS_RESULTS = 12;

/** Headlines placed first when the query is about something current. */
const NEWS_SLOTS = 3;

/** Of those, how many community sources may take before the general engines have had theirs. */
const COMMUNITY_SLOTS = 4;

interface SourceHits {
  provider: KeylessProvider;
  order: number;
  hits: SearchResult[];
}

/**
 * The keyless sources: every one at once, merged.
 *
 * A source that errors, is rate limited, times out or has changed its markup contributes nothing and
 * the others answer. That is the whole point of carrying several — any single scraped page is one
 * redesign away from silence, and silence is the failure mode that looks like the feature working.
 * Asking them one after another, as this used to, made the slowest of them the speed of every search.
 */
export async function searchKeyless(
  providers: KeylessProvider[],
  query: string,
  intent: SearchIntent,
  doFetch: typeof fetch,
): Promise<KeylessOutcome> {
  // Only the kinds of source the model asked for: a developer source answering a gold price is noise,
  // and GitHub's unauthenticated budget is ten searches a minute.
  const indexed = providers
    .map((provider, order) => ({ provider, order }))
    .filter(({ provider }) => intent.groups.includes(provider.group) && (!provider.when || provider.when(intent)));
  const answered = await fanOut(indexed.filter((p) => p.provider.tier !== "backup"), query, intent, doFetch);

  const webAnswered = answered.some((a) => a.provider.tier === "web" && a.hits.length > 0);
  if (!webAnswered) {
    const backups = indexed.filter((p) => p.provider.tier === "backup");
    if (backups.length > 0) answered.push(...(await fanOut(backups, query, intent, doFetch)));
  }

  const hits = mergeKeyless(answered, intent.recent);
  // Every source empty is a normal outcome here, not an error: the model should try different words
  // rather than be told the tool is broken.
  if (hits.length === 0) return { hits: [] };
  const sources = [...new Set(answered.filter((a) => a.hits.length > 0).sort((x, y) => x.order - y.order).map((a) => a.provider.name))];
  return { hits, source: sources.join("+") };
}

/**
 * Dial every source at once; resolve when all have answered, or a short grace after the first
 * general engine has. Sources still out at that point are aborted and contribute nothing.
 */
function fanOut(
  sources: { provider: KeylessProvider; order: number }[],
  query: string,
  intent: SearchIntent,
  doFetch: typeof fetch,
): Promise<SourceHits[]> {
  return new Promise((resolve) => {
    const answered: SourceHits[] = [];
    const stop = new AbortController();
    let pending = sources.length;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (grace) clearTimeout(grace);
      stop.abort();
      resolve(answered);
    };
    if (pending === 0) return finish();

    for (const { provider, order } of sources) {
      querySource(provider, query, intent, doFetch, stop.signal)
        .then((hits) => {
          if (finished) return;
          answered.push({ provider, order, hits });
          // With no general engine asked for, whichever source answers first sets the pace instead.
          const general = provider.tier === "web" || provider.tier === "backup" || !intent.groups.includes("web");
          if (hits.length > 0 && general && !grace) grace = setTimeout(contained(log, "could not end a keyless search's wait", finish), KEYLESS_GRACE_MS);
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0) finish();
        });
    }
  });
}

/** One source, under its own deadline. Never throws: a failure is an empty answer, and logged. */
async function querySource(
  provider: KeylessProvider,
  query: string,
  intent: SearchIntent,
  doFetch: typeof fetch,
  stop: AbortSignal,
): Promise<SearchResult[]> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(KEYLESS_SOURCE_TIMEOUT_MS)]);
  try {
    const res = await untilAborted(doFetch(provider.url(query, intent), { headers: provider.headers ?? {}, signal }), signal);
    if (!res.ok) {
      log.debug("keyless search source refused", { source: provider.name, status: res.status });
      return [];
    }
    const hits = extractResults(await untilAborted(res.text(), signal), provider, intent);
    // Dropped here, so an engine that answered nothing but someone else's results counts as having
    // answered nothing — it must not start the grace period either.
    if (provider.mayPoison && looksPoisoned(hits, query, Math.min(3, provider.maxResults ?? 3))) {
      log.debug("keyless search source answered off-topic", { source: provider.name });
      return [];
    }
    if (hits.length === 0) log.debug("keyless search source returned nothing", { source: provider.name });
    return hits;
  } catch (err) {
    if (!stop.aborted) log.debug("keyless search source failed", { source: provider.name, error: String(err) });
    return [];
  }
}

/**
 * The general engines first, interleaved so neither one's ranking buries the other's; then the
 * community sources, capped; then whatever is left of either, until the list is full. The same page
 * found twice is listed once, where it ranked first.
 *
 * News leads instead when the model says the answer is recent — a gold price "hari ini" is answered
 * by this morning's headline, not by the dealer's homepage — and is one more community source when
 * it is not.
 */
function mergeKeyless(answered: SourceHits[], recent: boolean): SearchResult[] {
  const byOrder = [...answered].sort((a, b) => a.order - b.order);
  const tier = (...tiers: KeylessProvider["tier"][]) =>
    interleave(byOrder.filter((a) => tiers.includes(a.provider.tier)).map((a) => a.hits));
  const web = tier("web", "backup");
  const news = tier("news");
  const community = recent ? tier("community") : interleave([news, tier("community")]);

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  const take = (pool: SearchResult[], limit: number) => {
    for (const hit of pool) {
      if (merged.length >= limit) return;
      const key = hit.url.replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?]+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  };
  if (recent) take(news, NEWS_SLOTS);
  take(web, MAX_KEYLESS_RESULTS - Math.min(COMMUNITY_SLOTS, community.length));
  take(community, MAX_KEYLESS_RESULTS);
  take(web, MAX_KEYLESS_RESULTS);
  if (recent) take(news, MAX_KEYLESS_RESULTS);
  return merged;
}

function interleave(lists: SearchResult[][]): SearchResult[] {
  const out: SearchResult[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) if (list[i]) out.push(list[i]!);
  return out;
}

