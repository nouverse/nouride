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

export class CacheBreaks {
  private readonly last = new Map<string, string>();

  /**
   * Whether the prefix `key` names (the prompt, the model, the tools, as one digest) lost its cache since the
   * conversation's last request — and remembered as its last. `lifetimeMs` is how long the conversation's endpoint
   * keeps one. A conversation this process has not seen says only what its idle says: after a restart, the first turn
   * is not taken to have lost it.
   */
  lost(sessionId: string, key: string, lastAt: number | undefined, now: number, lifetimeMs: number): boolean {
    const before = this.last.get(sessionId);
    this.last.delete(sessionId);
    if (this.last.size >= KEPT) this.last.delete(this.last.keys().next().value!);
    this.last.set(sessionId, key);
    return (lastAt !== undefined && now - lastAt >= lifetimeMs) || (before !== undefined && before !== key);
  }
}
