/**
 * The Missions board's decisions (`modules/missions/lib/board.ts`): the column, the card's line and time, the bar's
 * fill, where a phone opens and what an old link's tab means now. What the board draws of them is
 * `mount-missions-list.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { MissionView } from "@nouride/wire";
import { barFill, boardSummary, cardLine, columnOf, doneWhen, FINISHED_SPAN, FINISHED_SPANS, fromLink, phoneOpening, timeLine } from "@/modules/missions/lib/board";

const NOW = 1_800_000_000_000;
const base = { status: "running", seen: "working", waitKind: null, startedAt: 1, changeable: true, answers: [], checks: [], accept: false, reviewOn: false, reason: null, report: null, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, endedAt: null, checklist: null, person: undefined } as unknown as MissionView;
const m = (more: Partial<MissionView>): MissionView => ({ ...base, ...more });
const DRAFT = m({ status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null });

describe("the column", () => {
  test("a draft is in the Backlog and never in Needs you; a result to accept, a question or approvals need the reader", () => {
    expect(columnOf(DRAFT)).toBe("backlog");
    for (const waitKind of ["accept", "input", "approval", "limit"] as const) expect(columnOf(m({ status: "waiting", seen: "needs_you", waitKind }))).toBe("needs");
  });

  test("queued, running and checking are at work; done, failed and stopped have finished", () => {
    for (const status of ["queued", "running", "checking"] as const) expect(columnOf(m({ status, seen: "working" }))).toBe("working");
    expect(columnOf(m({ status: "done", seen: "done" }))).toBe("finished");
    for (const status of ["failed", "stopped"] as const) expect(columnOf(m({ status, seen: "ended" }))).toBe("finished");
  });

  test("one waiting for someone else is at work as the reader sees it", () => {
    expect(columnOf(m({ status: "waiting", seen: "needs_you", waitKind: "input", changeable: false }))).toBe("working");
  });
});

describe("a card", () => {
  test("its line by its column: when a draft is done, what one at work does, what one asks, why one failed, who stopped one", () => {
    expect(cardLine(m({ ...DRAFT, checks: ["a", "b"], accept: true }))).toEqual({ label: "Done when", text: "2 checks pass, then you accept" });
    expect(cardLine(m({ checklist: { done: 1, total: 3, active: "Write report.md" } }))).toEqual({ label: "Now", text: "Write report.md" });
    expect(cardLine(m({ status: "waiting", seen: "needs_you", waitKind: "input", answers: [{ question: "Keep\\nit?", at: 1 }] }))).toEqual({ label: "Asks", text: "Keep\\nit?" });
    expect(cardLine(m({ status: "failed", seen: "ended", reason: "no key" }))).toEqual({ label: "Why", text: "no key" });
    expect(cardLine(m({ status: "stopped", seen: "ended", reason: "stopped by gading" }))).toEqual({ label: "By", text: "gading" });
    expect(cardLine(m({ status: "done", seen: "done", report: "All tidy." }))).toBeNull();
  });

  test("what a draft takes to be done: its checks, then the person or a reviewer", () => {
    expect(doneWhen({ checks: [], accept: false, reviewOn: false })).toBe("it says it is done");
    expect(doneWhen({ checks: ["a"], accept: false, reviewOn: true })).toBe("1 check pass, then a reviewer signs it off");
  });

  test("one time line each", () => {
    expect(timeLine(DRAFT, NOW)).toBe("drafted 1 min ago");
    expect(timeLine(m({ activeAt: NOW - 120_000 }), NOW)).toBe("last step 2 min ago");
    expect(timeLine(m({ status: "stopped", seen: "ended", endedAt: NOW - 3 * 3_600_000 }), NOW)).toBe("stopped 3 h ago");
  });

  test("the bar: done green, failed its own red, stopped grey, the rest primary", () => {
    expect(barFill(m({ status: "done", seen: "done" }))).toBe("bg-success");
    expect(barFill(m({ status: "failed", seen: "ended" }))).toBe("bg-failed");
    expect(barFill(m({ status: "stopped", seen: "ended" }))).toBe("bg-base-content/35");
    expect(barFill(m({}))).toBe("bg-primary");
  });
});

describe("the page", () => {
  test("Finished goes back 7, 14, 21 or 30 days, 7 unless chosen", () => {
    expect([...FINISHED_SPANS]).toEqual([7, 14, 21, 30]);
    expect(FINISHED_SPAN).toBe(7);
  });

  test("a phone opens on Needs you when anything does, Working otherwise", () => {
    expect(phoneOpening({ backlog: 3, working: 2, needs: 1, finished: 4 })).toBe("needs");
    expect(phoneOpening({ backlog: 3, working: 0, needs: 0, finished: 4 })).toBe("working");
  });

  test("a link that named an old tab lands on the column that holds it", () => {
    expect(fromLink("needs_you")).toEqual({ column: "needs" });
    expect(fromLink("working")).toEqual({ column: "working" });
    expect(fromLink("done")).toEqual({ column: "finished", outcome: "done" });
    expect(fromLink("stopped")).toEqual({ column: "finished", outcome: "stopped" });
    expect(fromLink("all")).toBeNull();
    expect(fromLink(undefined)).toBeNull();
  });

  test("the line under the title", () => {
    expect(boardSummary({ backlog: 2, working: 2, needs: 1, finished: 4 })).toBe("2 in the backlog, 2 working, 1 needs you");
    expect(boardSummary({ backlog: 0, working: 1, needs: 2, finished: 0 })).toBe("0 in the backlog, 1 working, 2 need you");
  });
});
