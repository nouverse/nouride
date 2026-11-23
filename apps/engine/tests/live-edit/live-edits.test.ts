/**
 * Live edit, the part every kind of thing shares (`modules/live-edit`): what a turn is told of what its message's page
 * holds open, and a change an agent wrote, held for that page.
 *
 * Each case is a way it would cost or mislead: the thing said again with every message of a long conversation, a
 * changed one not said again, a thing cut and written back cut, a kind nobody knows said as if it were one, a change
 * kept for good, or a body that is not a live edit taking its message down with it.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, LiveEdit } from "@nouride/shared";
import { LIVE_EDIT_MAX_CHARS, LiveEdits, liveEditOf, type LiveEditKind } from "@/modules/live-edit/index.ts";

const THING: LiveEditKind = {
  tool: "write_thing",
  noun: "thing",
  said: (open) => (open.value && typeof open.value === "object" ? { ...(open.value as Record<string, unknown>) } : null),
  how: "To change it, call `write_thing` with all of it.",
};
const made = (now = () => 1_000) => new LiveEdits({ thing: THING }, now);
const OPEN: LiveEdit = { kind: "thing", id: "t_1", value: { name: "Morning", steps: ["a", "b"] } };
const who = { agentId: "nouva" };
const kept = (note: string): ChatMessage => ({ role: "user", content: `change step two\n\n${note}` });

describe("what a turn is told of what the page holds open", () => {
  test("the thing whole, as its tool takes it, that it is not saved, and how to change it", () => {
    const note = made().note(OPEN, [], who)!;
    expect(note).toStartWith("(On that page the person has this thing open and is changing it. It is NOT saved: this is the page's own copy, as it stands now, with whatever they have changed on it. [shown ");
    expect(note).toContain("\nTo change it, call `write_thing` with all of it.\n```json\n");
    expect(JSON.parse(/```json\n([\s\S]*)\n```\)$/.exec(note)![1]!)).toEqual({ name: "Morning", steps: ["a", "b"] });
  });

  test("one being made is said as new, and not as one that exists", () => {
    expect(made().note({ ...OPEN, id: null }, [], who)).toContain("the person has a new thing, not made yet open");
  });

  test("said once for each form it takes: the same one again is one line, and a changed one is said whole again", () => {
    const edits = made();
    const first = edits.note(OPEN, [], who)!;
    const again = edits.note(OPEN, [kept(first)], who)!;
    const print = /\[shown [0-9a-f]{10}\]/.exec(first)![0];
    expect(again).toBe(`(On that page the person still has this thing open, as it was shown to you above ${print}. To change it, call \`write_thing\` with all of it.)`);
    expect(again).not.toContain("```");
    // Changed on the page since: what the turn read above is no longer what is there.
    const changed = edits.note({ ...OPEN, value: { name: "Morning", steps: ["a", "b", "c"] } }, [kept(first)], who)!;
    expect(changed).toContain("```json");
    expect(changed).not.toContain(print);
    // And the same value under another id is another thing.
    expect(edits.note({ ...OPEN, id: "t_2" }, [kept(first)], who)).toContain("```json");
  });

  test("a history that no longer holds it, or holds it only in the agent's own words, is told it whole again", () => {
    const edits = made();
    const first = edits.note(OPEN, [], who)!;
    expect(edits.note(OPEN, [{ role: "user", content: "an older message" }], who)).toContain("```json");
    expect(edits.note(OPEN, [{ role: "assistant", content: first }], who)).toContain("```json");
  });

  test("one too long to say is said to be too long, with how long, and never cut", () => {
    const note = made().note({ kind: "thing", id: "t_1", value: null, tooLong: 61_234 }, [], who)!;
    expect(note).toBe(
      "(On that page the person has this thing open and is changing it. It is too long to show here (61234 characters, the most is 48000), so you cannot change it from this chat. Say so in one line: they change it on the page itself.)",
    );
  });

  test("nothing for a page that holds nothing, a kind nobody knows, or a value its kind cannot read", () => {
    const edits = made();
    expect(edits.note(undefined, [], who)).toBeNull();
    expect(edits.note({ kind: "spreadsheet", id: "s_1", value: {} }, [], who)).toBeNull();
    expect(edits.note({ kind: "thing", id: "t_1", value: "words" }, [], who)).toBeNull();
    expect(edits.knows("thing")).toBe(true);
    expect(edits.knows("spreadsheet")).toBe(false);
    // A kind named as something every object has is no kind.
    expect(edits.knows("toString")).toBe(false);
  });
});

describe("a change held for its page", () => {
  const offer = { kind: "thing", target: "t_1", value: { name: "Evening" }, by: "nouva", gatewayId: "web:dashboard", chatId: "web-1", senderId: "usr_1" };

  test("is handed back by the id its call was given, as it was written, with when", () => {
    const edits = made(() => 5_000);
    const id = edits.propose(offer);
    expect(id).toMatch(/^edit_[0-9a-f]{20}$/);
    expect(edits.offered(id)).toEqual({ ...offer, id, at: 5_000 });
    expect(edits.offered("edit_nobody")).toBeNull();
    // Two of the same change are two, each with its own id.
    expect(edits.propose(offer)).not.toBe(id);
  });

  test("is forgotten a day on, and the oldest once there are more than a hundred", () => {
    let now = 0;
    const edits = made(() => now);
    const first = edits.propose(offer);
    now = 24 * 60 * 60_000;
    expect(edits.offered(first)).not.toBeNull();
    now += 1;
    expect(edits.offered(first)).toBeNull();

    const ids = Array.from({ length: 101 }, () => edits.propose(offer));
    expect(edits.offered(ids[0]!)).toBeNull();
    expect(edits.offered(ids[1]!)).not.toBeNull();
    expect(edits.offered(ids.at(-1)!)).not.toBeNull();
  });
});

describe("what a page sent beside its message", () => {
  const knows = (kind: string) => kind === "thing";

  test("is a live edit when it names a kind the daemon knows and holds an object: which one by its id, or none for one being made", () => {
    expect(liveEditOf({ kind: "thing", id: " t_1 ", value: { a: 1 } }, knows)).toEqual({ liveEdit: { kind: "thing", id: "t_1", value: { a: 1 } } });
    expect(liveEditOf({ kind: "thing", id: null, value: { a: 1 } }, knows)).toEqual({ liveEdit: { kind: "thing", id: null, value: { a: 1 } } });
    expect(liveEditOf({ kind: "thing", id: "", value: {} }, knows)).toEqual({ liveEdit: { kind: "thing", id: null, value: {} } });
    expect(liveEditOf({ kind: "thing", id: "x".repeat(300), value: {} }, knows).liveEdit!.id).toHaveLength(80);
  });

  test("anything else is no live edit, and never a refusal: the message goes on without it", () => {
    for (const raw of [undefined, null, "words", 7, [], {}, { kind: "spreadsheet", value: {} }, { kind: "thing" }, { kind: "thing", value: "words" }, { kind: "thing", value: [1] }, { kind: "thing", value: null }, { kind: 3, value: {} }]) {
      expect(liveEditOf(raw, knows)).toEqual({});
    }
  });

  test("one too long to say to a model is kept as its length alone: at the bound it is whole, one character past it is not", () => {
    const sized = (chars: number) => ({ kind: "thing", id: "t_1", value: { text: "x".repeat(chars - '{"text":""}'.length) } });
    const whole = liveEditOf(sized(LIVE_EDIT_MAX_CHARS), knows).liveEdit!;
    expect(whole.tooLong).toBeUndefined();
    expect(JSON.stringify(whole.value)).toHaveLength(LIVE_EDIT_MAX_CHARS);
    expect(liveEditOf(sized(LIVE_EDIT_MAX_CHARS + 1), knows)).toEqual({ liveEdit: { kind: "thing", id: "t_1", value: null, tooLong: LIVE_EDIT_MAX_CHARS + 1 } });
  });
});
