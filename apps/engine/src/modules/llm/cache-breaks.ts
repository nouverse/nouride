/**
 * Whether a conversation's cached prefix is gone anyway — the moment rewriting its history costs nothing more.
 * Clearing old tool output out of a history changes every byte after it, and a provider caches the prefix: done on
 * every turn, it would turn each request into a cache write. Done when the system prompt, the model or the tools
 * changed since the conversation's last request, or nothing was asked of it for as long as its endpoint keeps a
 * cache, the cache was lost before this turn began.
 */

/**
 * How long a cache is taken to live on an endpoint that does not say (`LLMProvider.cacheLifetimeMs`): an hour, a
 * starting value past the few minutes most keep one. Long on purpose. A cache taken for warm when it is gone only
 * leaves old output in place until there is enough of it to pay for the rewrite; one taken for gone when it is warm
 * rewrites a prefix the provider would have read back at a fraction of the price.
 */
export const ASSUMED_CACHE_LIFETIME_MS = 60 * 60_000;
/** Conversations remembered at most: past it the oldest is forgotten, and its next turn says only what its idle says. */
const KEPT = 2_000;

/** What became of a conversation's cached prefix since its last request. */
export interface CacheBreak {
  /** Whether it is gone: nothing was asked for as long as the endpoint keeps one, or the prefix is not what it was. */
  lost: boolean;
  /** Whether the idle time alone lost it. */
  idle: boolean;
  /**
   * The parts of the prefix that are not what they were at the conversation's last request, by name, in the order
   * given. Empty when none changed, and for a conversation this process has not seen. The first of them is where a
   * provider's cache stops matching: everything after it in the request is written again, the conversation with it.
   */
  changed: string[];
}

export class CacheBreaks {
  private readonly last = new Map<string, Record<string, string>>();

  /**
   * What became of the prefix whose parts are `parts` (each a digest by its name: the model, the tools, each section
   * of the prompt) since the conversation's last request, and remembered as its last. `lifetimeMs` is how long the
   * conversation's endpoint keeps a cache. A conversation this process has not seen says only what its idle says:
   * after a restart, the first turn is not taken to have lost it.
   */
  seen(sessionId: string, parts: Record<string, string>, lastAt: number | undefined, now: number, lifetimeMs: number): CacheBreak {
    const before = this.last.get(sessionId);
    this.last.delete(sessionId);
    if (this.last.size >= KEPT) this.last.delete(this.last.keys().next().value!);
    this.last.set(sessionId, parts);
    const idle = lastAt !== undefined && now - lastAt >= lifetimeMs;
    // A part that is new, one that is gone, and one that reads differently each count: all three move what follows.
    const changed = before === undefined ? [] : [...new Set([...Object.keys(parts), ...Object.keys(before)])].filter((name) => parts[name] !== before[name]);
    return { lost: idle || changed.length > 0, idle, changed };
  }

  /** Whether the prefix `key` names, as one digest, lost its cache since the conversation's last request. */
  lost(sessionId: string, key: string, lastAt: number | undefined, now: number, lifetimeMs: number): boolean {
    return this.seen(sessionId, { prefix: key }, lastAt, now, lifetimeMs).lost;
  }
}
