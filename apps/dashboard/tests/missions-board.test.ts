/**
 * The Missions board's decisions (`modules/missions/lib/board.ts`): the column, the card's line and time, the bar's
 * fill, where a phone opens and what an old link's tab means now. What the board draws of them is
 * `mount-missions-list.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { MissionView, NotesPlanStep } from "@nouride/wire";
import { stepsShown } from "@/modules/missions/components/Checklist";
import { badgeOf, barFill, cardLine, columnOf, dayBeside, doneWhen, FINISHED_SPAN, FINISHED_SPANS, fromLink, phoneOpening, SHOWN, STAGES, timeLine, whenLines, whenTip } from "@/modules/missions/lib/board";

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

describe("one held up because its model could not answer", () => {
  // The owner, of a mission at its plan's limit under "Needs you" with Continue beside it: could it not try
  // again by itself every hour? It did, and nothing on its card or its page said when.
  const HELD = m({ status: "waiting", seen: "needs_you", waitKind: "retry", reason: "usage limit reached", updatedAt: NOW - 13 * 60_000, retryAt: NOW + 47 * 60_000 });

  test("is at work as the reader sees it, never in Needs you", () => {
    expect(columnOf(HELD)).toBe("working");
    // Running, the same wait kind left on its record means nothing: only one that waits is held up.
    expect(badgeOf(m({ waitKind: "retry" }))).toBe("Working");
  });

  test("its card says held up, and when it tries again", () => {
    expect(badgeOf(HELD)).toBe("Held up");
    expect(cardLine(HELD, NOW)).toEqual({ label: "Held up", text: "Its model could not answer. It tries again by itself in 47 min, then an hour apart at most, for about a day." });
    expect(timeLine(HELD, NOW)).toBe("held up 13 min ago");
    expect(whenLines(HELD).at(-1)).toEqual({ label: "Held up since", at: NOW - 13 * 60_000 });
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

  test("three stages on a wide page, Finished apart from them, and five shown in each before the rest", () => {
    expect(STAGES).toEqual(["backlog", "working", "needs"]);
    expect(SHOWN).toBe(5);
  });
});

describe("a checklist folded", () => {
  const step = (text: string, state: NotesPlanStep["state"] = "pending"): NotesPlanStep => ({ text, state });
  const twelve = (active: number | null) => Array.from({ length: 12 }, (_, at) => step(`step ${at + 1}`, active === null ? "done" : at < active ? "done" : at === active ? "active" : "pending"));
  const shown = (steps: NotesPlanStep[], open = false) => stepsShown(steps, open).steps.map((one) => one.text);

  test("five show, the one at work with two on either side, so how far it is needs no press", () => {
    expect(shown(twelve(7))).toEqual(["step 6", "step 7", "step 8", "step 9", "step 10"]);
    expect(stepsShown(twelve(7), false).from).toBe(5);
    // At either end the five are still five.
    expect(shown(twelve(0))).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
    expect(shown(twelve(11))).toEqual(["step 8", "step 9", "step 10", "step 11", "step 12"]);
  });

  test("with none at work the first five; opened, or five and fewer, all of them", () => {
    expect(shown(twelve(null))).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
    expect(shown(twelve(7), true)).toHaveLength(12);
    expect(shown(twelve(2).slice(0, 5))).toHaveLength(5);
  });
});

describe("when, behind the time line", () => {
  const DAY = 86_400_000;
  const made = NOW - 20 * DAY;
  const began = NOW - 3 * DAY;
  const labels = (mission: MissionView) => whenLines(mission).map((line) => [line.label, line.at]);

  test("a draft was only made; work also started; one that waits says since when; one that ended says when", () => {
    expect(labels(m({ ...DRAFT, createdAt: made }))).toEqual([["Created", made]]);
    expect(labels(m({ createdAt: made, startedAt: began }))).toEqual([["Created", made], ["Started", began]]);
    expect(labels(m({ status: "waiting", seen: "needs_you", waitKind: "input", createdAt: made, startedAt: began, updatedAt: NOW - DAY }))).toEqual([["Created", made], ["Started", began], ["Waiting since", NOW - DAY]]);
    expect(labels(m({ status: "done", seen: "done", createdAt: made, startedAt: began, endedAt: NOW - DAY }))).toEqual([["Created", made], ["Started", began], ["Ended", NOW - DAY]]);
  });

  test("the tip names each moment with its day and its minute, in order", () => {
    const tip = whenTip(m({ status: "done", seen: "done", createdAt: made, startedAt: began, endedAt: NOW - DAY }));
    expect(tip).toMatch(/^Created .+ · Started .+ · Ended .+$/);
    expect(tip).toContain(String(new Date(made).getFullYear()));
    expect(tip).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  test("where nothing can be hovered the day stands beside the line: the day it speaks of, or the day work began", () => {
    const day = (at: number) => new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
    const sameYear = (at: number) => new Date(at).getFullYear() === new Date(NOW).getFullYear();
    // Twenty days back may cross a year's end: then the year is said too, which is all this leaves to the helper.
    if (sameYear(made)) expect(dayBeside(m({ ...DRAFT, createdAt: made }), NOW)).toBe(day(made));
    if (sameYear(began)) expect(dayBeside(m({ createdAt: made, startedAt: began }), NOW)).toBe(`since ${day(began)}`);
    if (sameYear(NOW - DAY)) expect(dayBeside(m({ status: "done", seen: "done", createdAt: made, startedAt: began, endedAt: NOW - DAY }), NOW)).toBe(day(NOW - DAY));
    expect(dayBeside(m({ ...DRAFT, createdAt: NOW - 400 * DAY }), NOW)).toContain(String(new Date(NOW - 400 * DAY).getFullYear()));
  });
});
