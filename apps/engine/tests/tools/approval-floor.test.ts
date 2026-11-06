/**
 * One question in front of a person at a time.
 *
 * The unit under the concurrency change: two peers can now work at once, and both of them can stop
 * for a human. What must never happen is two prompts racing into one chat, because a bare `/approve`
 * cannot tell them apart and neither can the person reading it.
 *
 * These are the rules that the SQLite gate and the chat hook both lean on, tested without either.
 */

import { describe, expect, test } from "bun:test";
import { ApprovalFloor, chatKey } from "@/modules/tools/approval-floor.ts";

const CHAT = chatKey("telegram:nouva", "-100123");
const OTHER = chatKey("telegram:nouva", "-100999");

/** A prompt that records when it was shown, and how many were behind it at that moment. */
function prompt(id: string, log: { id: string; behind: number }[]) {
  return { id, show: (behind: number) => void log.push({ id, behind }) };
}

describe("holding the floor", () => {
  test("the first question is shown at once", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    expect(floor.enter(CHAT, prompt("a", shown))).toBe(true);
    expect(shown).toEqual([{ id: "a", behind: 0 }]);
    expect(floor.displayed(CHAT)).toBe("a");
  });

  test("the second waits, and is not shown until the first settles", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    expect(floor.enter(CHAT, prompt("b", shown))).toBe(false);

    // The whole point: one prompt, not two.
    expect(shown.map((s) => s.id)).toEqual(["a"]);

    floor.leave("a");
    expect(shown.map((s) => s.id)).toEqual(["a", "b"]);
    expect(floor.displayed(CHAT)).toBe("b");
  });

  test("the count behind is what is true when it is read, not when it was queued", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    floor.enter(CHAT, prompt("b", shown));
    floor.enter(CHAT, prompt("c", shown));

    // `a` was alone when it went up and two arrived behind it afterwards — it cannot claim a number
    // it could not have known. `b` sees the one still behind it.
    expect(shown).toEqual([{ id: "a", behind: 0 }]);

    floor.leave("a");
    expect(shown.at(-1)).toEqual({ id: "b", behind: 1 });
    floor.leave("b");
    expect(shown.at(-1)).toEqual({ id: "c", behind: 0 });
  });

  test("they are shown in the order they were asked", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();
    for (const id of ["a", "b", "c"]) floor.enter(CHAT, prompt(id, shown));

    floor.leave("a");
    floor.leave("b");
    floor.leave("c");
    expect(shown.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("two conversations are two people", () => {
  test("a question in one chat never waits for a question in another", () => {
    // Making them wait for each other would be a deadlock dressed as politeness: the person in the
    // second chat cannot answer the first one's question and has no way to know they are behind it.
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    expect(floor.enter(OTHER, prompt("b", shown))).toBe(true);
    expect(shown.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("settling one chat's question promotes only that chat's queue", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    floor.enter(CHAT, prompt("a2", shown));
    floor.enter(OTHER, prompt("b", shown));
    floor.enter(OTHER, prompt("b2", shown));

    floor.leave("a");
    expect(shown.map((s) => s.id)).toEqual(["a", "b", "a2"]);
    expect(floor.displayed(OTHER)).toBe("b");
  });
});

describe("settling from somewhere other than the chat", () => {
  test("answering a queued request from the CLI promotes nothing and loses nobody", () => {
    // A queued request is `pending` in the database like any other, so `nouride approvals` and the
    // dashboard can answer it before it has ever been posted. That must not hand the floor to
    // anybody — the request that has it still has it.
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    floor.enter(CHAT, prompt("b", shown));
    floor.enter(CHAT, prompt("c", shown));

    floor.leave("b");
    expect(shown.map((s) => s.id)).toEqual(["a"]);
    expect(floor.displayed(CHAT)).toBe("a");

    // And `b` is gone rather than merely skipped: `c` is next, and nothing shows `b` afterwards.
    floor.leave("a");
    expect(shown.map((s) => s.id)).toEqual(["a", "c"]);
  });
});

describe("expiring in bulk", () => {
  test("a request being expired is never put on screen on its way out", () => {
    // `expireAll` finishes a list one at a time, and each finish promotes the next — which may be the
    // next one on the same list. Without `drop`, the operator watches a prompt appear and expire in
    // the same instant.
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("a", shown));
    floor.enter(CHAT, prompt("b", shown));
    floor.enter(CHAT, prompt("c", shown));

    floor.drop(["a", "b", "c"]);
    floor.leave("a");
    floor.leave("b");
    floor.leave("c");

    expect(shown.map((s) => s.id)).toEqual(["a"]);
    expect(floor.displayed(CHAT)).toBeNull();
  });

  test("the floor passes to the first request that is going to survive", () => {
    // `/reset` for one agent expires that agent's requests. Another agent's question in the same
    // chat is not part of that and has to be asked.
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();

    floor.enter(CHAT, prompt("nouva-1", shown));
    floor.enter(CHAT, prompt("nouva-2", shown));
    floor.enter(CHAT, prompt("nexa-1", shown));

    floor.drop(["nouva-1", "nouva-2"]);
    floor.leave("nouva-1");
    floor.leave("nouva-2");

    expect(shown.map((s) => s.id)).toEqual(["nouva-1", "nexa-1"]);
    expect(floor.displayed(CHAT)).toBe("nexa-1");
  });
});

describe("shutdown", () => {
  test("nothing is promoted on the way out", () => {
    const shown: { id: string; behind: number }[] = [];
    const floor = new ApprovalFloor();
    floor.enter(CHAT, prompt("a", shown));
    floor.enter(CHAT, prompt("b", shown));

    floor.clear();
    floor.leave("a");

    expect(shown.map((s) => s.id)).toEqual(["a"]);
    expect(floor.displayed(CHAT)).toBeNull();
  });
});

describe("the count on screen", () => {
  /** A prompt that records each time it is told how many wait behind it now. */
  const counted = (id: string, said: [string, number][]) => ({ id, show: () => {}, recount: (behind: number) => void said.push([id, behind]) });

  test("is said again as one is asked behind it and as one behind it settles — not for one going with them", () => {
    const said: [string, number][] = [];
    const floor = new ApprovalFloor();
    floor.enter(CHAT, counted("a", said));
    floor.enter(CHAT, counted("b", said));
    floor.enter(CHAT, counted("c", said));
    expect(said).toEqual([["a", 1], ["a", 2]]);
    expect([floor.shown("a"), floor.shown("b")]).toEqual([true, false]);

    // Answered from the dashboard while it waited.
    floor.leave("c");
    expect(said.at(-1)).toEqual(["a", 1]);

    // `/approve all`: the one on screen is answered with the rest, so there is nothing to say again on it.
    floor.drop(["a", "b"]);
    expect(said).toHaveLength(3);
  });
});
