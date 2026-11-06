/**
 * Memory's tag tools, as `createMemory` hands them out — the list, the tidy's plan, apply, a hand merge,
 * undo, and the model's suggestions when a person asks for them (`tidy.ts`, `tag-suggest.ts`).
 *
 * A tidy rewrites episodes, so it takes the same maintenance turn as the pass, a reindex and a forget:
 * asked for while one of those runs, it is refused by name rather than queued behind it.
 */

import { syncIndex } from "./index-sync.ts";
import { pruneTagStubs } from "./graph.ts";
import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import { parseSuggestions, SUGGEST_TOKENS, suggestPrompt, type Suggestions } from "./tag-suggest.ts";
import { normalizeTag, qualifiedAtFor } from "./tags.ts";
import { applyTidy, lastTidy, planTidy, undoTidy, type Tagged, type TidyChange, type TidyPlan, type TidyRecord } from "./tidy.ts";
import type { Vault } from "./vault.ts";

export interface TagToolsDeps {
  vault: Vault;
  index: MemoryIndexPort;
  analytics: Pick<MemoryAnalyticsPort, "tagCounts">;
  now: () => number;
  /** What maintenance job is running, if any. */
  busy: () => string | null;
  /** Run as the one maintenance job. */
  exclusive: <T>(what: string, run: () => Promise<T>) => Promise<T>;
}

export function createTagTools(deps: TagToolsDeps) {
  const tagged = (): Tagged[] =>
    [...deps.index.pages({})].flatMap((page) => page.filter((episode) => episode.tags.length > 0).map((episode) => ({ id: episode.id, kind: episode.kind, tags: episode.tags })));

  /** After the files changed: aliases re-read from the stubs, and stubs nothing shares any more removed. */
  async function settle(): Promise<void> {
    await syncIndex(deps.vault, deps.index);
    await pruneTagStubs(deps.vault, deps.analytics.tagCounts().counts);
  }

  async function run<T>(what: string, work: () => Promise<T | { refused: string }>, backup?: () => Promise<unknown>): Promise<T | { refused: string }> {
    const running = deps.busy();
    if (running) return { refused: `${running} is running, so try again when it is done` };
    return await deps.exclusive(what, async () => {
      await backup?.();
      const result = await work();
      if (!(result && typeof result === "object" && "refused" in result)) await settle();
      return result;
    });
  }

  /**
   * Apply what a person ticked, by id from a plan of the vault as it is now — plus the model's groups
   * they kept, or one hand merge. `backup` runs first: the vault snapshot, as before a deploy.
   */
  async function apply(ids: readonly string[], extra: readonly TidyChange[], actor: string, backup?: () => Promise<unknown>): Promise<TidyRecord | { refused: string }> {
    return await run(
      "a tag tidy",
      async () => {
        const episodes = tagged();
        const plan = planTidy(episodes, qualifiedAtFor(episodes.length));
        const chosen = [...plan.changes.filter((change) => ids.includes(change.id)), ...extra];
        return await applyTidy({ vault: deps.vault, index: deps.index, now: deps.now }, episodes, chosen, actor);
      },
      backup,
    );
  }

  return {
    /** Every tag with the conversations it is on, most used first, and its aliases. */
    list(): { tags: { tag: string; n: number; aliases: string[] }[]; once: number } {
      const { counts } = deps.analytics.tagCounts();
      const aliases = new Map<string, string[]>();
      for (const [alias, tag] of deps.index.aliases()) aliases.set(tag, [...(aliases.get(tag) ?? []), alias]);
      const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => ({ tag, n, aliases: (aliases.get(tag) ?? []).sort() }));
      return { tags, once: tags.filter((entry) => entry.n === 1).length };
    },

    /** What the rules would tidy now. Computed on each call from the index — a few grouped reads. */
    plan(): TidyPlan {
      const episodes = tagged();
      return planTidy(episodes, qualifiedAtFor(episodes.length));
    },

    apply,

    /** The model's groups for the vocabulary as it is now — when a person asks; not stored, not applied. */
    async suggest(ask: (prompt: { system: string; user: string }, maxTokens?: number) => Promise<string | null>): Promise<Suggestions | { refused: string }> {
      const { counts } = deps.analytics.tagCounts();
      const tags = [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
      const answer = await ask(suggestPrompt(tags), SUGGEST_TOKENS);
      if (answer === null) return { refused: "the model could not be asked" };
      return parseSuggestions(answer, counts);
    },

    /** A person's merge — Merge into… on a tag — applied and recorded like any tidy, and undone the same way. */
    async merge(from: readonly string[], into: string, actor: string, backup?: () => Promise<unknown>): Promise<TidyRecord | { refused: string }> {
      const target = normalizeTag(into, new Map());
      const names = [...new Set(from.map((tag) => normalizeTag(tag, new Map())).filter((tag): tag is string => tag !== null && tag !== target))];
      if (!target || names.length === 0) return { refused: "a merge needs tags to merge and a tag to merge them into" };
      return await apply([], [{ id: "hand", kind: "merge", from: names, into: target, episodes: 0, why: "hand" }], actor, backup);
    },

    async undo(): Promise<{ restored: number; skipped: string[] } | { refused: string }> {
      return await run("undoing a tag tidy", () => undoTidy({ vault: deps.vault, index: deps.index, now: deps.now }));
    },

    last: () => lastTidy(deps.vault),
  };
}

export type TagTools = ReturnType<typeof createTagTools>;
