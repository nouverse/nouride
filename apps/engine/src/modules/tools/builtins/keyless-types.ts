/**
 * The shape of a keyless search source, and of what the model asks of one. Kept apart from the
 * sources themselves so the extraction and the fan-out can name them without the list.
 */

import type { SearchResult } from "@/modules/tools/builtins/search-backends.ts";

/**
 * What kind of answer a search is after, as the *model* says — it knows why it is searching, and a
 * keyword list guessing at that from the query does not: every such list is missing the next word.
 */
export type SearchGroup = "web" | "news" | "code" | "papers" | "wiki" | "forum";
export const SEARCH_GROUPS: SearchGroup[] = ["web", "news", "code", "papers", "wiki", "forum"];

/** Asked when the model names none: what an everyday question wants. */
const DEFAULT_SEARCH_GROUPS: SearchGroup[] = ["web", "news", "wiki", "forum"];

export interface SearchIntent {
  groups: SearchGroup[];
  /**
   * The language (and optionally region) results are wanted in, as a BCP-47 tag: `en`, `id`, `ja`,
   * `pt-BR`. Picks the news edition and adds that language's Wikipedia beside the English one.
   */
  lang: string;
  /** The answer depends on what happened recently: headlines lead. */
  recent: boolean;
}

export const DEFAULT_SEARCH_INTENT: SearchIntent = { groups: DEFAULT_SEARCH_GROUPS, lang: "en", recent: false };

/**
 * A search source with a public page or API and no key.
 *
 * Asked *together*, not one after another. The chain this replaced tried each source in turn with no
 * deadline, so one that hung — DuckDuckGo throttling a scraper does exactly that — held the whole
 * search for as long as the socket stayed open, and an agent waiting on it looked frozen. Now every
 * source is dialled at once under its own deadline, and the answer is whatever came back.
 *
 * Three tiers, because they are not the same kind of answer:
 *
 * - `web` — general engines. Their results lead, and the first of them to answer starts a short grace
 *   period after which the search returns with whatever else has arrived.
 * - `backup` — dialled only when every `web` source came back empty. The DuckDuckGo lite page is the
 *   same service as the HTML one, so asking it on every search doubles the load on the one host most
 *   likely to throttle us, for results that are almost always duplicates.
 * - `news` — Google News, in the edition for the language asked. Leads the list when the model says the answer is recent; otherwise it is
 *   one more community source.
 * - `community` — GitHub, Reddit, Hacker News, Stack Overflow, npm, MDN, arXiv, Wikipedia. Where a
 *   technical answer usually actually lives. Capped to a few slots.
 *
 * Which of them are asked is the model's call, through `sources` (see `SearchGroup`): the developer
 * ones only for `code`, arXiv only for `papers`. So a question about the weather is not padded with
 * repositories — and GitHub's 10-a-minute budget is not spent on it.
 *
 * Sources are only listed here once they have been *probed against the live endpoint*. Mojeek was
 * tried and dropped: its result markup could not be matched reliably. Reddit's own `search.json`
 * answers 403 to anything without OAuth, so Reddit is reached through DuckDuckGo's `site:` filter —
 * Bing's RSS view ignores `site:`, which was also probed.
 *
 * **Not Google.** It serves a consent interstitial or a JavaScript-only page to anything that is not a
 * browser, so it would contribute empty results most of the time while looking like it was tried.
 */
export interface KeylessProvider {
  name: string;
  tier: "web" | "backup" | "news" | "community";
  /** Asked when the search's `sources` include this. */
  group: SearchGroup;
  /** Further narrowing, such as a language edition. Absent means always, within its group. */
  when?(intent: SearchIntent): boolean;
  url(query: string, intent: SearchIntent): string;
  headers?: Record<string, string>;
  /** Anchor pattern: group 1 is the href, group 2 the title. For page sources. */
  linkPattern?: RegExp;
  /** Snippet pattern, paired positionally with the links. Absent means no snippets from this source. */
  snippetPattern?: RegExp;
  /** For JSON sources, in place of the patterns. A body that is not JSON contributes nothing. */
  parse?(body: unknown, intent: SearchIntent): SearchResult[];
  /** For XML feeds and other text a pattern pair cannot pair up, in place of the patterns. */
  parseText?(body: string, intent: SearchIntent): SearchResult[];
  /**
   * An engine that may answer a bot with someone else's results rather than refuse. Its answer is
   * discarded whole when none of it mentions the query — see `looksPoisoned`.
   */
  mayPoison?: boolean;
  /** Drop results this source returns that are not what it is for, such as an engine's own links. */
  keep?(url: string): boolean;
  /** At most this many of its results are used. */
  maxResults?: number;
}
