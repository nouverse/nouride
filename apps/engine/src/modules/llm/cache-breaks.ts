/**
 * Whether a conversation's cached prefix is gone anyway (TOKEN_SAVINGS §3.2, 0.8.13) — the moment rewriting its
 * history costs nothing more. Clearing old tool output out of a history changes every byte after it, and a provider
 * caches the prefix: done on every turn, it would turn each request into a cache write. Done when the system prompt,
 * the model or the tools changed since the conversation's last request, or nothing was asked of it for an hour, the
 * cache was lost before this turn began.
 */

/** Idle this long, no provider's cache of the prefix is still warm — a starting value, past their usual few minutes. */
export const IDLE_MS = 60 * 60_000;
/** Conversations remembered at most: past it the oldest is forgotten, and its next turn says only what its idle says. */
const KEPT = 2_000;

export class CacheBreaks {
  private readonly last = new Map<string, string>();

  /**
   * Whether the prefix `key` names (the prompt, the model, the tools, as one digest) lost its cache since the
   * conversation's last request — and remembered as its last. A conversation this process has not seen says only what
   * its idle says: after a restart, the first turn is not taken to have lost it.
   */
  lost(sessionId: string, key: string, lastAt: number | undefined, now: number): boolean {
    const before = this.last.get(sessionId);
    this.last.delete(sessionId);
    if (this.last.size >= KEPT) this.last.delete(this.last.keys().next().value!);
    this.last.set(sessionId, key);
    return (lastAt !== undefined && now - lastAt >= IDLE_MS) || (before !== undefined && before !== key);
  }
}
