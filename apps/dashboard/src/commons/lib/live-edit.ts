/**
 * Live edit, the page's side: an agent changes what a person has open on a page, in place.
 *
 * A page that holds something open to be changed says so here while it is drawn (`useLiveEdit`); the chat that floats
 * over it sends that thing with each message (`liveEditHeld`, read by `page-open.ts`), so the agent is told what is
 * open and unsaved. When the agent writes a change, its call's step carries an id; the chat fetches the change and
 * offers it here (`offerLiveEdit`), and the page that holds that thing draws it for the person to apply or discard.
 * Nothing is applied by arriving, and nothing is saved by being applied: the page's own Save is the person's.
 *
 * One page holds one thing, and one change waits at a time: a newer one for the same thing is the agent's last word.
 * Both are the browser's alone, kept for as long as the dashboard is open and no longer.
 *
 * A change waits for the thing it was written for and no longer. One for something being made names nothing (its
 * target is none), so it fits every page that makes one: applied and saved, it was drawn again over the next new
 * one a person began. So a change answered is not offered again as it arrives (`answered`), one still waiting when
 * its page's draft is over goes with it (`endLiveEdit`), and one asked for from the chat is drawn only where the
 * page on screen holds what it changes (`holdsOpen`), never left for a later page.
 *
 * `changesBetween` is what any such page marks a change with: which of a list's items it adds, changes and removes.
 */

import type { LiveEdit, LiveEditOffer } from "@nouride/wire";

/** What the page on screen holds open, read as a message is sent: its value is asked for then, as it stands. */
let held: { by: symbol; kind: string; id: string | null; value: () => unknown } | null = null;

/** Says what the page holds open. Hands back the way to take it back, which leaves a later page's own alone. */
export function holdOpen(open: { kind: string; id: string | null; value: () => unknown }): () => void {
  const by = Symbol(open.kind);
  held = { by, ...open };
  return () => {
    if (held?.by === by) held = null;
  };
}

/** What the page on screen holds open now, as a message sends it; nothing where no page holds anything. */
export function liveEditHeld(): LiveEdit | undefined {
  return held ? { kind: held.kind, id: held.id, value: held.value() } : undefined;
}

/** Whether the page on screen holds that very thing now: a change to it would be drawn at once. */
export const holdsOpen = (kind: string, id: string | null): boolean => held !== null && held.kind === kind && held.id === id;

/** The change waiting to be drawn, and who listens for one. */
let offer: LiveEditOffer | null = null;
const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

/** The changes this browser has answered, by their ids: the newest of them, which is all a page can still be handed. */
const answered = new Set<string>();
const ANSWERED_KEPT = 200;

/**
 * A change an agent wrote, handed to whichever page holds what it changes. The newest takes the place of one waiting.
 * `arrived`: as the agent's turn wrote it; one answered already is not taken again, and this says so. `asked`: the
 * person asked the chat for it again, which is theirs to do with one they applied or discarded.
 */
export function offerLiveEdit(next: LiveEditOffer, how: "arrived" | "asked" = "arrived"): boolean {
  if (how === "arrived" && answered.has(next.id)) return false;
  offer = next;
  tell();
  return true;
}

/** A change answered, applied or discarded: no longer waiting. One that is not the one waiting is left alone. */
export function dropLiveEdit(id: string): void {
  answered.add(id);
  if (answered.size > ANSWERED_KEPT) answered.delete(answered.values().next().value as string);
  if (offer?.id !== id) return;
  offer = null;
  tell();
}

/**
 * What a page held is over: one being made was saved as a thing of its own, or thrown away. A change still waiting
 * for it goes with it, as answered. One for anything else is left alone.
 */
export function endLiveEdit(kind: string, target: string | null): void {
  if (offer && offer.kind === kind && offer.target === target) dropLiveEdit(offer.id);
}

/** Nothing waits and nothing is remembered as answered: the page's tests begin each case as a browser just opened does. */
export function forgetLiveEdits(): void {
  offer = null;
  answered.clear();
  tell();
}

export const waitingLiveEdit = (): LiveEditOffer | null => offer;
export function watchLiveEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** What a change does to one item of a list. */
export type Mark = "added" | "changed" | "removed";

/** The longest run of items that do the same in both lists, in order: each pair of places that match. */
function matched(a: readonly string[], b: readonly string[]): [number, number][] {
  const longest: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) longest[i]![j] = a[i] === b[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * Each item's mark, by its id, in the list as it is (`before`: changed, removed) and as the change would leave it
 * (`after`: added, changed). Pure.
 *
 * Items are matched by what they do (`does`), not by their ids: a list written anew has its items named by their
 * place, so one put in at the second place gives every item after it a new id, and by id each of them would read as
 * changed when only one was added. An item that does the same at the same place among the others has no mark, unless
 * `also` (what else is said of it against the list it is in, such as where its paths lead) differs. Of the rest, one
 * that keeps its id and its `kind` is changed; what is left of `after` is added, and what is left of `before` removed.
 */
export function changesBetween<T>(
  before: readonly T[],
  after: readonly T[],
  of: { id: (item: T) => string; does: (item: T) => string; kind?: (item: T) => string; also?: (item: T, among: readonly T[]) => string },
): { before: Map<string, Mark>; after: Map<string, Mark> } {
  const marks = { before: new Map<string, Mark>(), after: new Map<string, Mark>() };
  const pairs = matched(before.map(of.does), after.map(of.does));
  const [seenBefore, seenAfter] = [new Set(pairs.map(([i]) => i)), new Set(pairs.map(([, j]) => j))];
  for (const [i, j] of pairs) {
    if (!of.also || of.also(before[i]!, before) === of.also(after[j]!, after)) continue;
    marks.before.set(of.id(before[i]!), "changed");
    marks.after.set(of.id(after[j]!), "changed");
  }
  after.forEach((item, j) => {
    if (seenAfter.has(j)) return;
    const i = before.findIndex((one, at) => !seenBefore.has(at) && of.id(one) === of.id(item) && (of.kind?.(one) ?? "") === (of.kind?.(item) ?? ""));
    if (i < 0) return void marks.after.set(of.id(item), "added");
    seenBefore.add(i);
    marks.before.set(of.id(before[i]!), "changed");
    marks.after.set(of.id(item), "changed");
  });
  before.forEach((item, i) => {
    if (!seenBefore.has(i)) marks.before.set(of.id(item), "removed");
  });
  return marks;
}
