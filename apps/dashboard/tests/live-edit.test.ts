/**
 * Live edit, the page's side that every page shares (`commons/lib/live-edit.ts`): what the page on screen holds open,
 * the change waiting for it, and what a change adds, changes and removes in a list.
 *
 * Each case is a way it would mislead: a page that left still said to hold its thing, a value read when the page was
 * drawn and not when the message was sent, a change for one thing kept from the page that holds it by one for
 * another, or a list written anew read as every item changed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LiveEditOffer } from "@nouride/wire";
import { changesBetween, dropLiveEdit, holdOpen, liveEditHeld, offerLiveEdit, waitingLiveEdit, watchLiveEdit } from "@/commons/lib/live-edit";

const offer = (id: string, target: string | null = "t_1"): LiveEditOffer => ({ id, kind: "thing", target, value: { name: id }, by: "nouva", at: 1 });
afterEach(() => {
  const waiting = waitingLiveEdit();
  if (waiting) dropLiveEdit(waiting.id);
});

describe("what the page on screen holds open", () => {
  test("is said while the page is drawn, with its value as it stands when it is asked for", () => {
    let name = "Morning";
    const leave = holdOpen({ kind: "thing", id: "t_1", value: () => ({ name }) });
    expect(liveEditHeld()).toEqual({ kind: "thing", id: "t_1", value: { name: "Morning" } });
    // Changed on the page since: what a message sends is what is there now.
    name = "Evening";
    expect(liveEditHeld()).toEqual({ kind: "thing", id: "t_1", value: { name: "Evening" } });
    leave();
    expect(liveEditHeld()).toBeUndefined();
  });

  test("a page that goes takes back only its own: the next page's stays, whichever leaves last", () => {
    const first = holdOpen({ kind: "thing", id: "t_1", value: () => 1 });
    const second = holdOpen({ kind: "thing", id: null, value: () => 2 });
    first();
    expect(liveEditHeld()).toEqual({ kind: "thing", id: null, value: 2 });
    second();
    expect(liveEditHeld()).toBeUndefined();
    // Taken back twice is taken back once.
    second();
    expect(liveEditHeld()).toBeUndefined();
  });
});

describe("the change waiting for its page", () => {
  test("is the newest one offered, told to whoever watches, until it is answered", () => {
    let told = 0;
    const stop = watchLiveEdit(() => void (told += 1));
    offerLiveEdit(offer("edit_1"));
    expect(waitingLiveEdit()?.id).toBe("edit_1");
    offerLiveEdit(offer("edit_2"));
    expect(waitingLiveEdit()?.id).toBe("edit_2");
    // An answer to the one it took the place of leaves the newer one waiting.
    dropLiveEdit("edit_1");
    expect(waitingLiveEdit()?.id).toBe("edit_2");
    dropLiveEdit("edit_2");
    expect(waitingLiveEdit()).toBeNull();
    expect(told).toBe(3);
    stop();
    offerLiveEdit(offer("edit_3"));
    expect(told).toBe(3);
  });
});

describe("what a change does to a list", () => {
  type Item = { id: string; kind: string; says: string; next?: string };
  const of = { id: (item: Item) => item.id, does: (item: Item) => `${item.kind}:${item.says}`, kind: (item: Item) => item.kind, also: (item: Item, among: readonly Item[]) => among.find((one) => one.id === item.next)?.says ?? "" };
  const marks = (before: Item[], after: Item[], how = of) => {
    const found = changesBetween(before, after, how);
    return { before: Object.fromEntries(found.before), after: Object.fromEntries(found.after) };
  };
  const NOW: Item[] = [{ id: "a", kind: "run", says: "check" }, { id: "b", kind: "say", says: "down" }];

  test("the same list has no marks, and an item at the end is added", () => {
    expect(marks(NOW, NOW)).toEqual({ before: {}, after: {} });
    expect(marks(NOW, [...NOW, { id: "c", kind: "run", says: "log" }])).toEqual({ before: {}, after: { c: "added" } });
  });

  test("an item that says something else under its id is changed on both sides; one that is gone is removed", () => {
    expect(marks(NOW, [NOW[0]!, { id: "b", kind: "say", says: "up again" }])).toEqual({ before: { b: "changed" }, after: { b: "changed" } });
    expect(marks(NOW, [NOW[0]!])).toEqual({ before: { b: "removed" }, after: {} });
  });

  test("a list written anew, its ids by place: one item put in is one item added, not every item after it changed", () => {
    const anew: Item[] = [{ id: "s1", kind: "run", says: "check" }, { id: "s2", kind: "run", says: "wait" }, { id: "s3", kind: "say", says: "down" }];
    expect(marks(NOW, anew)).toEqual({ before: {}, after: { s2: "added" } });
  });

  test("an id kept under another kind is another item: the old one removed, the new one added", () => {
    expect(marks(NOW, [NOW[0]!, { id: "b", kind: "run", says: "down" }])).toEqual({ before: { b: "removed" }, after: { b: "added" } });
    // With no kind to tell them by, the same id is the same item, changed.
    const { kind: _kind, ...kindless } = of;
    expect(marks(NOW, [NOW[0]!, { id: "b", kind: "run", says: "down" }], kindless as typeof of)).toEqual({ before: { b: "changed" }, after: { b: "changed" } });
  });

  test("what else is said of an item against its list is a change of its own; where nothing else is said, it is none", () => {
    const linked: Item[] = [{ id: "a", kind: "run", says: "check", next: "b" }, { id: "b", kind: "say", says: "down" }, { id: "c", kind: "say", says: "up" }];
    const elsewhere = [{ ...linked[0]!, next: "c" }, linked[1]!, linked[2]!];
    expect(marks(linked, elsewhere)).toEqual({ before: { a: "changed" }, after: { a: "changed" } });
    // The same item under another id is where it led before: no change.
    const renamed = [{ ...linked[0]!, next: "s2" }, { ...linked[1]!, id: "s2" }, linked[2]!];
    expect(marks(linked, renamed)).toEqual({ before: {}, after: {} });
    const { also: _also, ...plain } = of;
    expect(marks(linked, elsewhere, plain as typeof of)).toEqual({ before: {}, after: {} });
  });

  test("an item moved among the others, keeping its id, is changed", () => {
    const three: Item[] = [...NOW, { id: "c", kind: "run", says: "log" }];
    expect(marks(three, [three[2]!, three[0]!, three[1]!])).toEqual({ before: { c: "changed" }, after: { c: "changed" } });
  });
});
