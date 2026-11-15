/**
 * The order the transcript is drawn in.
 *
 * Every bug this has had was an ordering one, and each looked like a data problem: the reply above
 * the question, the question below a progress card it predates. So the ordering is a pure function
 * with its own tests rather than a `.sort()` buried in the render.
 */

import { describe, expect, test } from "bun:test";
import { interleave } from "../src/commons/lib/interleave.ts";
import type { ChatEvent, ChatTurn, LiveTurn, RoomMessage } from "@nouride/wire";

const message = (id: string, at: number) => ({ id, at, text: id } as RoomMessage);
const turn = (id: string, at: number) => ({ id, startedAt: at, agentId: "a" } as ChatTurn);
const live = (id: string, at: number) => ({ id, startedAt: at, agentId: "a" } as LiveTurn);
const event = (id: string, at: number) => ({ id, at, kind: "joined" } as ChatEvent);

const ids = (entries: ReturnType<typeof interleave>) =>
  entries.map((entry) =>
    entry.kind === "message"
      ? entry.message.id
      : entry.kind === "event"
        ? entry.event.id
        : entry.turn.id,
  );

describe("interleaving a room", () => {
  test("a running turn sits where it began, not at the bottom", () => {
    /**
     * The bug: running turns were appended after everything. Correct in a one-to-one chat, where
     * there is one and it is always newest. In a room it drew every progress card at the bottom, so
     * asking Nouva something slow and then asking Nero put Nero's question *above* Nouva's progress
     * — the earlier question rendered after the later one.
     */
    const out = interleave(
      [],
      [live("nouva-working", 100)],
      [],
      [message("ask-nouva", 90), message("ask-nero", 200)],
    );

    expect(ids(out)).toEqual(["ask-nouva", "nouva-working", "ask-nero"]);
  });

  test("a message comes before the turn it started, in the same millisecond", () => {
    // They are stamped a tick apart at most: the envelope when it arrives, the record when the turn
    // begins. On a live box both read the same millisecond and the answer was drawn first.
    const out = interleave([turn("reply", 500)], [], [], [message("question", 500)]);

    expect(ids(out)).toEqual(["question", "reply"]);
  });

  test("an event comes before a message in the same millisecond", () => {
    // A room's `joined` is written as the room is created, and the first message can land in the same
    // tick — "Sam started this room" belongs above what they then said.
    const out = interleave([], [], [event("joined", 10)], [message("first", 10)]);

    expect(ids(out)).toEqual(["joined", "first"]);
  });

  test("two agents working on one message keep the order they started in", () => {
    const out = interleave(
      [],
      [live("nero", 120), live("nouva", 110)],
      [],
      [message("both", 100)],
    );

    expect(ids(out)).toEqual(["both", "nouva", "nero"]);
  });

  test("an asked agent's answer said in the room is above the turn that asked for it, whose own answer came after", () => {
    // Nouva's turn began at 100 and ended at 400; Nix's answer was said at 300, while Nouva still worked.
    const asking = { id: "nouva-asks", startedAt: 100, endedAt: 400, agentId: "nouva" } as ChatTurn;
    const shown = { id: "nix-answers", startedAt: 300, endedAt: 300, agentId: "nix", cause: { via: "shown answer", asked: "nouva", parent: "nouva-asks" } } as ChatTurn;
    expect(ids(interleave([asking, shown], [], [event("delegated", 150)], [message("ask", 100), message("later", 500)]))).toEqual(["ask", "nix-answers", "nouva-asks", "delegated", "later"]);
    // The asking turn still at work: the same place, above its progress.
    const working = { id: "nouva-asks", startedAt: 100, agentId: "nouva", status: "running" } as LiveTurn;
    expect(ids(interleave([shown], [working], [], [message("ask", 100)]))).toEqual(["ask", "nix-answers", "nouva-asks"]);
  });

  test("one said after the asking turn had ended, an ask behind that turn, is where it was said", () => {
    const asking = { id: "nouva-asks", startedAt: 100, endedAt: 200, agentId: "nouva" } as ChatTurn;
    const shown = { id: "nix-answers", startedAt: 900, agentId: "nix", cause: { via: "shown answer", parent: "nouva-asks" } } as ChatTurn;
    expect(ids(interleave([asking, shown], [], [], [message("ask", 100), message("meanwhile", 500)]))).toEqual(["ask", "nouva-asks", "meanwhile", "nix-answers"]);
    // And one whose asking turn is no longer among what is drawn, or that names none.
    expect(ids(interleave([shown], [], [], [message("meanwhile", 500)]))).toEqual(["meanwhile", "nix-answers"]);
    const nameless = { id: "nix-answers", startedAt: 900, agentId: "nix", cause: { via: "shown answer" } } as ChatTurn;
    expect(ids(interleave([asking, nameless], [], [], []))).toEqual(["nouva-asks", "nix-answers"]);
    // Another turn's cause that names a parent is not this: a delegate's own turn stays where it began.
    const other = { id: "job-turn", startedAt: 300, agentId: "nix", cause: { via: "job completion", parent: "nouva-asks" } } as ChatTurn;
    expect(ids(interleave([{ ...asking, endedAt: 400 }, other], [], [], []))).toEqual(["nouva-asks", "job-turn"]);
  });
});
