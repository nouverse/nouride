/**
 * An automation's unsaved changes as they are kept in the browser (`lib/kept-draft.ts`): what is kept, what never is,
 * and what is read back as a draft the page can open. A page left with six steps drawn and nothing saved opened empty.
 */

import { describe, expect, test } from "bun:test";
import { blankDraft, type Draft } from "@/modules/automations/lib/draft";
import { KEPT_MOST, NEW, baseOf, forKeeping, isDraft, isKeptDrafts, keptKey, keptWords, restored, withKept, type KeptDrafts } from "@/modules/automations/lib/kept-draft";
import type { Step } from "@/modules/automations/lib/steps";

const STEPS: Step[] = [
  { id: "s1", kind: "agentTurn", message: "Sum up the mail.", agentId: "nix" },
  { id: "s2", kind: "command", argv: ["python3"], script: { text: "print(1)\n", about: "Counts to one.", secrets: ["notes_key"] }, whenFailed: "next" },
  { id: "s3", kind: "approval", ask: "Send it?" },
  { id: "s4", kind: "parallel", steps: [{ id: "s4-1", kind: "agentTurn", message: "Read the news." }, { id: "s4-2", kind: "command", argv: ["ls"] }] },
  { id: "s5", kind: "mission", goal: "Bring it back." },
  { id: "s6", kind: "systemEvent", text: "Done." },
];
const draft = (over: Partial<Draft> = {}): Draft => ({ ...blankDraft("nouva", "telegram:nouva", "UTC"), name: "Morning check", chatId: "8142", steps: STEPS, ...over });
const kept = (at: number, over: Partial<Draft> = {}) => ({ draft: draft(over), at, base: "b" });

describe("what is kept", () => {
  test("a draft goes through the browser's store and comes back the draft it was, every kind of step in it", () => {
    const all = withKept({}, NEW, kept(5));
    const back: unknown = JSON.parse(JSON.stringify(all));
    expect(isKeptDrafts(back)).toBe(true);
    expect((back as KeptDrafts)[NEW]).toEqual(kept(5));
  });

  test("the address another app is called at is never kept: it can hold that app's key, and is the saved automation's own", () => {
    const calls = draft({ delivery: { mode: "webhook", webhookUrl: "https://hooks.example.com/T0/B0/k3y", once: true } });
    const stored = JSON.stringify(withKept({}, "cron_a", { draft: calls, at: 1, base: "b" }));
    expect(stored).not.toContain("hooks.example.com");
    expect(forKeeping(calls).delivery).toEqual({ mode: "webhook", once: true });
    // Put back from the automation as it is saved, when the page opens on the draft again.
    expect(restored(forKeeping(calls), calls).delivery).toEqual(calls.delivery);
    expect(restored(forKeeping(draft()), draft())).toEqual(draft());
    // A script's keys are names, as everywhere: the names are kept, and there is no value to keep.
    expect(stored).toContain("notes_key");
  });

  test("what an automation was when a draft was made from it is told apart from what it is now", () => {
    expect(baseOf(draft())).toBe(baseOf(draft()));
    expect(baseOf(draft())).not.toBe(baseOf(draft({ name: "Evening check" })));
    expect(baseOf(draft())).not.toBe(baseOf(draft({ steps: STEPS.slice(0, 5) })));
    // The address that is never kept is no part of the mark either: a draft would never match what it was made from.
    expect(baseOf(draft({ delivery: { mode: "webhook", webhookUrl: "https://a.example.com" } }))).toBe(baseOf(draft({ delivery: { mode: "webhook", webhookUrl: "https://b.example.com" } })));
  });

  test("one person's drafts are another's under another key", () => {
    expect(keptKey("alex")).not.toBe(keptKey("sam"));
    expect(keptKey("alex")).toContain("v1");
  });
});

describe("what is read back", () => {
  const bad: [string, unknown][] = [
    ["nothing", null],
    ["a list", []],
    ["a draft of another build, with no steps", { ...draft(), steps: undefined }],
    ["a step of a kind this build does not know", { ...draft(), steps: [{ id: "s1", kind: "teleport" }] }],
    ["a step without what its kind is written in", { ...draft(), steps: [{ id: "s1", kind: "agentTurn" }] }],
    ["a script with no text", { ...draft(), steps: [{ id: "s1", kind: "command", argv: ["sh"], script: { about: "x" } }] }],
    ["a start nothing starts by", { ...draft(), start: "voice" }],
    ["a trigger that is half there", { ...draft(), trigger: { mode: "daily" } }],
    ["no place it reports", { ...draft(), delivery: null }],
  ];
  for (const [what, value] of bad) {
    test(`${what} is not a draft the page opens: it is as if nothing had been kept`, () => {
      expect(isDraft(value)).toBe(false);
      expect(isKeptDrafts({ [NEW]: { draft: value, at: 1, base: "b" } })).toBe(false);
    });
  }

  test("a kept entry needs its time and what it was made from", () => {
    expect(isKeptDrafts({ [NEW]: { draft: draft() } })).toBe(false);
    expect(isKeptDrafts({ [NEW]: { draft: draft(), at: "now", base: "b" } })).toBe(false);
    expect(isKeptDrafts({})).toBe(true);
  });
});

describe("one person's drafts", () => {
  test("one is set, set again, and taken out; the others stay", () => {
    let all = withKept({}, NEW, kept(1));
    all = withKept(all, "cron_a", kept(2, { name: "A" }));
    all = withKept(all, NEW, kept(3, { name: "Changed" }));
    expect(Object.keys(all).sort()).toEqual(["cron_a", NEW]);
    expect(all[NEW]!.draft.name).toBe("Changed");
    expect(withKept(all, NEW, null)).toEqual({ cron_a: kept(2, { name: "A" }) });
    expect(withKept(all, "cron_z", null)).toEqual(all);
  });

  test("past the most kept, the oldest go first, and the one just changed is never the one that goes", () => {
    let all: KeptDrafts = {};
    for (let n = 1; n <= KEPT_MOST; n += 1) all = withKept(all, `cron_${n}`, kept(n + 100));
    expect(Object.keys(all)).toHaveLength(KEPT_MOST);
    // The one changed now is older by its clock than every other: it stays, and the oldest of the others goes.
    all = withKept(all, NEW, kept(1));
    expect(Object.keys(all)).toHaveLength(KEPT_MOST);
    expect(all[NEW]).toBeDefined();
    expect(all.cron_1).toBeUndefined();
    expect(all.cron_2).toBeDefined();
  });

  test("the list says of one not saved yet what it is called and how much of it there is", () => {
    expect(keptWords(kept(1))).toEqual({ name: "Morning check", holds: "6 steps" });
    expect(keptWords(kept(1, { name: "  ", steps: [] }))).toEqual({ name: "No name yet", holds: "No steps yet" });
    expect(keptWords(kept(1, { steps: STEPS.slice(0, 1) })).holds).toBe("1 step");
  });
});
