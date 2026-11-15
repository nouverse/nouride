/**
 * Which missions wait for the reader, and what each card says it waits for (`commons/lib/mission-waits.ts`). Every one
 * said "Waiting for your answer": a draft kept for later stood there as a question, and a mission that asked one while
 * it went on working was not listed at all.
 */

import { describe, expect, test } from "bun:test";
import type { MissionAnswered, MissionView } from "@nouride/wire";
import { asksWhileWorking, openQuestion, waitingLine, waitsForReader } from "@/commons/lib/mission-waits";

type Row = Pick<MissionView, "status" | "waitKind" | "seen" | "startedAt" | "changeable"> & { answers?: MissionAnswered[] };
const waiting = (waitKind: MissionView["waitKind"], extra: Partial<Row> = {}): Row => ({ status: "waiting", seen: "needs_you", waitKind, startedAt: 1, ...extra });
const working = (extra: Partial<Row> = {}): Row => ({ status: "running", seen: "working", waitKind: null, startedAt: 1, ...extra });
const asked = (question: string, how: MissionAnswered["asked"] = "wait"): MissionAnswered => ({ question, at: 1, ...(how ? { asked: how } : {}) });

describe("the question a mission has open", () => {
  test("the one it waits on, the one it asked and works on past, and none once answered or ended", () => {
    expect(openQuestion(waiting("input", { answers: [asked("Which sheet?")] }))?.question).toBe("Which sheet?");
    expect(openQuestion(working({ answers: [asked("Mermaid?", "meanwhile")] }))?.question).toBe("Mermaid?");
    expect(openQuestion(working({ answers: [{ ...asked("Mermaid?", "meanwhile"), answer: "ya" }] }))).toBeNull();
    expect(openQuestion({ status: "stopped", waitKind: null, answers: [asked("Mermaid?", "meanwhile")] })).toBeNull();
    expect(openQuestion(working())).toBeNull();
    // A list row with no questions at all, as a mount test's or an older daemon's.
    expect(openQuestion({ status: "running", waitKind: null })).toBeNull();
  });

  test("an old unanswered line counts only on a mission that waits for it", () => {
    const old: MissionAnswered = { question: "Which sheet?", at: 1 };
    expect(openQuestion(waiting("input", { answers: [old] }))).toBe(old);
    expect(openQuestion(working({ answers: [old] }))).toBeNull();
    expect(openQuestion(waiting("stuck", { answers: [old] }))).toBeNull();
    expect(asksWhileWorking(working({ answers: [old] }))).toBe(false);
  });
});

describe("what waits for the reader", () => {
  test("a wait a person ends, and a mission at work that asked: not an approval, a pause for its model, or another person's", () => {
    for (const kind of ["input", "accept", "limit", "stuck", "unknown_outcome"] as const) expect(waitsForReader(waiting(kind))).toBe(true);
    expect(waitsForReader(working({ answers: [asked("Mermaid?", "meanwhile")] }))).toBe(true);
    expect(waitsForReader(working())).toBe(false);
    // Counted and answered as an approval; tried again by itself.
    expect(waitsForReader(waiting("approval"))).toBe(false);
    expect(waitsForReader(waiting("retry"))).toBe(false);
    // One the reader only reads waits for its own person, asking or waiting.
    expect(waitsForReader(waiting("input", { changeable: false }))).toBe(false);
    expect(waitsForReader(working({ answers: [asked("Mermaid?", "meanwhile")], changeable: false }))).toBe(false);
  });
});

describe("the card's line", () => {
  test("each wait in its own words, a question with the question on one line", () => {
    expect(waitingLine(waiting("input", { answers: [asked("Keep the old sheet?\n\nA) keep it\nB) drop it")] }))).toBe("Waiting for your answer: Keep the old sheet? A) keep it B) drop it");
    expect(waitingLine(waiting("input"))).toBe("Waiting for your answer");
    expect(waitingLine(working({ answers: [asked("Mermaid, at 735 KB?", "meanwhile")] }))).toBe("Asks, and works on meanwhile: Mermaid, at 735 KB?");
    expect(waitingLine(waiting("accept"))).toBe("Its result is ready. Accept it or send it back");
    expect(waitingLine(waiting("limit"))).toBe("Stopped at a limit. Let it go on or end it");
    expect(waitingLine(waiting("stuck"))).toBe("Stuck. See what stopped it");
    expect(waitingLine(waiting("unknown_outcome"))).toBe("Cut off by a restart. Check it, then let it go on");
  });

  test("a draft is never called an answer", () => {
    const line = waitingLine(waiting("accept", { startedAt: null }));
    expect(line).toBe("A draft, not started yet. Start it or drop it");
    expect(line.toLowerCase()).not.toContain("answer");
  });
});
