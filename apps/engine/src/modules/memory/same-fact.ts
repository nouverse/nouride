/**
 * Facts that say the same thing, shown once — what RECALL carries (`docs/SPEC.md` §12.3).
 *
 * A fact is readable where the conversation it came from was, so the same thing learned in a DM, on Discord and in two
 * groups is four lines, and a group never reads the DM's. Joining them into one line would make it readable wherever
 * any of them was said, and a near-copy is not the same text: the DM's may carry a detail the group never heard. So the
 * file keeps them apart, and where a chat may read several, it is shown one. A profile on the x64 box had five under
 * Work by 2026-10-22, all from different chats — the pass compares a new fact only with those its chat may read
 * (`restated` in `pass.ts`), so it could not have caught them.
 *
 * Alike within one section only: by meaning when both have a vector — cosine at least `NEAR`, and half the shorter
 * one's words shared, so a model that scores unrelated texts high cannot join two facts with nothing in common — and by
 * their words alone otherwise (`SAME_FACT`). Of facts alike, the one that says everything the others say is shown, or
 * else the newest.
 *
 * Pure.
 */

import type { IndexedFact } from "./memory-index.store.ts";
import { similarity } from "./semantic.ts";
import { overlapOf, SAME_FACT, sharedWords, wordSet } from "./terms.ts";
import { episodeDay } from "./vault.ts";

/**
 * Cosine at which two facts' vectors mean the same. Measured with bge-m3 over the 47 facts of one profile on the x64
 * box: the three restatements of "develops Nouride" 0.86–0.90; the closest fact that said something more (its maintainer,
 * who also writes articles) 0.79.
 */
const NEAR = 0.85;
/** Of the shorter fact's words, the share the other must have too, beside a close vector. */
const SHARED_WORDS = 0.5;

type Comparable = Pick<IndexedFact, "id" | "section" | "text" | "source">;

/** A fact as it is compared: its words read once. */
interface Read {
  fact: Comparable;
  words: ReadonlySet<string>;
}

function alike(a: Read, b: Read, vectors: ReadonlyMap<string, Int8Array> | undefined): boolean {
  if (a.fact.section !== b.fact.section) return false;
  const va = vectors?.get(a.fact.id);
  const vb = vectors?.get(b.fact.id);
  if (!va || !vb) return overlapOf(a.words, b.words) >= SAME_FACT;
  return similarity(va, vb) >= NEAR && sharedWords(a.words, b.words) >= SHARED_WORDS * Math.min(a.words.size, b.words.size);
}

/** Facts in their own order, each meaning once. `vectors` by fact id, of one model; a fact without one is compared by words. */
export function oncePerMeaning<T extends Comparable>(facts: readonly T[], vectors?: ReadonlyMap<string, Int8Array>): T[] {
  const newestFirst = facts
    .map((fact, i) => ({ fact, i, day: episodeDay(fact.source) ?? "", words: wordSet(fact.text) }))
    .sort((a, b) => (a.day === b.day ? b.i - a.i : a.day < b.day ? 1 : -1));
  const groups: (typeof newestFirst)[] = [];
  for (const entry of newestFirst) {
    const group = groups.find((members) => alike(members[0]!, entry, vectors));
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  // A fact whose words are all of its group's says everything the others say.
  const shown = new Set(
    groups.map((members) => {
      const all = new Set(members.flatMap((member) => [...member.words]));
      return (members.find((member) => member.words.size === all.size) ?? members[0]!).i;
    }),
  );
  return facts.filter((_, i) => shown.has(i));
}
