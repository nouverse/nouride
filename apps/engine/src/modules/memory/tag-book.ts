/**
 * The tags one nightly pass files against: read once when it starts, kept current as it files.
 *
 * Each audience's vocabulary is built once per run and reused for every one of its conversations, so
 * the text a model is shown is the same from call to call — the prefix a provider's cache reuses (on
 * the production box, Gemini's implicit cache). The counts the gate folds against move with every
 * episode filed, so a tag one conversation coins is a tag in use for the next.
 */

import type { EpisodeScope } from "./access.ts";
import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import { newAllowedFor, qualifiedAtFor, vocabularyOf, type TagContext, type Vocabulary } from "./tags.ts";

/** How far back a chat's own tags are offered, and how many. */
const CHAT_WINDOW_MS = 30 * 86_400_000;
const CHAT_TAGS = 12;

export interface TagBook {
  vocabulary(scope: EpisodeScope): Vocabulary;
  chatTags(chat: string): string[];
  /** The gate's context for a conversation in an audience with `tagged` tagged conversations. */
  context(tagged: number): TagContext;
  /** What an episode was filed with — counted at once, so the next episode sees those tags in use. */
  record(tags: readonly string[]): void;
  count(tag: string): number;
}

export function tagBook(deps: { analytics: Pick<MemoryAnalyticsPort, "tagUse" | "taggedIn" | "chatTags" | "tagCounts">; index: Pick<MemoryIndexPort, "aliases">; now: () => number }): TagBook {
  const { counts, tagged } = deps.analytics.tagCounts();
  const aliases = deps.index.aliases();
  const qualifiedAt = qualifiedAtFor(tagged);
  const vocabularies = new Map<string, Vocabulary>();
  return {
    vocabulary(scope) {
      const key = `${scope.chat}\u0000${scope.participant ?? ""}`;
      let vocabulary = vocabularies.get(key);
      if (!vocabulary) {
        vocabulary = vocabularyOf(deps.analytics.tagUse({ scope }), deps.now(), deps.analytics.taggedIn({ scope }));
        vocabularies.set(key, vocabulary);
      }
      return vocabulary;
    },
    chatTags: (chat) => deps.analytics.chatTags(chat, deps.now() - CHAT_WINDOW_MS, CHAT_TAGS),
    context: (tagged) => ({ inUse: counts, aliases, newAllowed: newAllowedFor(tagged), qualifiedAt }),
    record(tags) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    },
    count: (tag) => counts.get(tag) ?? 0,
  };
}
