/**
 * A change an agent wrote waits for the thing it was written for, and no longer (`lib/live-edit.ts`).
 *
 * One for something being made names nothing, so it fits every page that makes one. Applied and saved, it was drawn
 * again over the next new automation its person began: these are the three rules that end it with its draft.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LiveEditOffer } from "@nouride/wire";
import { dropLiveEdit, endLiveEdit, forgetLiveEdits, holdOpen, holdsOpen, offerLiveEdit, waitingLiveEdit } from "@/commons/lib/live-edit";

const change = (id: string, target: string | null = null): LiveEditOffer => ({ id, kind: "automation", target, value: { name: id }, by: "nouva", at: 1 });

// What waits and what was answered are the whole browser's: each case begins and ends with neither.
beforeEach(forgetLiveEdits);
afterEach(forgetLiveEdits);

describe("a change answered", () => {
  test("is not taken again as it arrives, applied or discarded; another change is", () => {
    expect(offerLiveEdit(change("edit_1"))).toBe(true);
    dropLiveEdit("edit_1");
    expect(waitingLiveEdit()).toBeNull();
    // The chat's reader hands the same step over again: a turn read anew, a card opened again.
    expect(offerLiveEdit(change("edit_1"))).toBe(false);
    expect(waitingLiveEdit()).toBeNull();
    expect(offerLiveEdit(change("edit_2"))).toBe(true);
    expect(waitingLiveEdit()?.id).toBe("edit_2");
  });

  test("is the person's to ask for again, and is then one to answer like any other", () => {
    offerLiveEdit(change("edit_1"));
    dropLiveEdit("edit_1");
    expect(offerLiveEdit(change("edit_1"), "asked")).toBe(true);
    expect(waitingLiveEdit()?.id).toBe("edit_1");
    dropLiveEdit("edit_1");
    expect(waitingLiveEdit()).toBeNull();
  });

  test("one never offered and answered by its id is remembered too: it may arrive after", () => {
    dropLiveEdit("edit_9");
    expect(offerLiveEdit(change("edit_9"))).toBe(false);
  });

  test("the newest two hundred are remembered: an older one is a change like any other again", () => {
    for (let i = 0; i <= 200; i += 1) dropLiveEdit(`edit_${i}`);
    expect(offerLiveEdit(change("edit_200"))).toBe(false);
    expect(offerLiveEdit(change("edit_1"))).toBe(false);
    expect(offerLiveEdit(change("edit_0"))).toBe(true);
  });
});

describe("what a page held is over", () => {
  test("a change waiting for it goes with it, as answered; one for anything else stays", () => {
    offerLiveEdit(change("edit_1", null));
    endLiveEdit("automation", "cron_e");
    endLiveEdit("mission", null);
    expect(waitingLiveEdit()?.id).toBe("edit_1");
    endLiveEdit("automation", null);
    expect(waitingLiveEdit()).toBeNull();
    expect(offerLiveEdit(change("edit_1", null))).toBe(false);
    // With nothing waiting it is nothing.
    endLiveEdit("automation", null);
    expect(waitingLiveEdit()).toBeNull();
  });
});

describe("what the page on screen holds", () => {
  test("is that thing and no other, for as long as its page says so", () => {
    expect(holdsOpen("automation", null)).toBe(false);
    const letGo = holdOpen({ kind: "automation", id: null, value: () => ({}) });
    expect(holdsOpen("automation", null)).toBe(true);
    expect(holdsOpen("automation", "cron_e")).toBe(false);
    expect(holdsOpen("mission", null)).toBe(false);
    letGo();
    expect(holdsOpen("automation", null)).toBe(false);
  });
});
