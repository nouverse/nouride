/**
 * The doubling schedule long work is nudged on — `commons/budget-watch.ts` (0.7.25). Driven by a clock of the test's own
 * through `check()`, and once by the real timer, at a base of milliseconds.
 */

import { describe, expect, test } from "bun:test";
import { BudgetWatch, type Nudge } from "@/commons/budget-watch.ts";
import { eventually, sleep } from "../wait.ts";

const MIN = 60_000;

/** A watch on a clock the test moves. */
function watched(baseMs: number, onNudge?: (nudge: Nudge) => void) {
  let now = 1_000_000;
  const seen: Nudge[] = [];
  const watch = new BudgetWatch({ baseMs, startedAt: now, now: () => now, onNudge: (nudge) => (seen.push(nudge), onNudge?.(nudge)) });
  return { watch, seen, at: (ms: number) => ((now = 1_000_000 + ms), watch.check()) };
}

describe("the schedule", () => {
  test("5, 10, 20, 40 minutes from a base of 5 — and nothing between them", () => {
    const w = watched(5 * MIN);
    expect(w.at(5 * MIN - 1)).toBe(0);
    expect(w.at(5 * MIN)).toBe(1);
    expect(w.at(9 * MIN)).toBe(0);
    expect(w.at(10 * MIN)).toBe(1);
    expect(w.at(19 * MIN)).toBe(0);
    expect(w.at(20 * MIN)).toBe(1);
    expect(w.at(40 * MIN)).toBe(1);
    expect(w.seen.map((nudge) => [nudge.nth, nudge.dueMs / MIN])).toEqual([[1, 5], [2, 10], [3, 20], [4, 40]]);
  });

  test("a timer that ran late fires each nudge it missed, once, in order", () => {
    const w = watched(5 * MIN);
    expect(w.at(21 * MIN)).toBe(3);
    expect(w.seen.map((nudge) => nudge.dueMs / MIN)).toEqual([5, 10, 20]);
    expect(w.seen.every((nudge) => nudge.elapsedMs === 21 * MIN)).toBe(true);
    expect(w.at(21 * MIN)).toBe(0);
  });

  test("stopped, it nudges no more", () => {
    const w = watched(5 * MIN);
    w.at(5 * MIN);
    w.watch.stop();
    expect(w.at(80 * MIN)).toBe(0);
    expect(w.seen).toHaveLength(1);
  });

  test("a base of 0 is off", () => {
    const w = watched(0);
    expect(w.at(1_000 * MIN)).toBe(0);
    w.watch.start();
    w.watch.stop();
  });

  test("a nudge that throws is contained, and the next one is still due", () => {
    const w = watched(5 * MIN, (nudge) => {
      if (nudge.nth === 1) throw new Error("the chat was gone");
    });
    expect(() => w.at(5 * MIN)).not.toThrow();
    expect(w.at(10 * MIN)).toBe(1);
    expect(w.seen.map((nudge) => nudge.nth)).toEqual([1, 2]);
  });
});

describe("on the real timer", () => {
  test("fires at the base and at twice it, a throwing nudge escapes nowhere, and stop ends it", async () => {
    const fired: number[] = [];
    const startedAt = Date.now();
    const at: number[] = [];
    const watch = new BudgetWatch({
      baseMs: 30,
      onNudge: (nudge) => {
        fired.push(nudge.nth);
        at.push(Date.now() - startedAt);
        throw new Error("thrown inside the timer");
      },
    }).start();
    await eventually(() => fired.length >= 2, 2_000, "two nudges");
    watch.stop();
    const after = fired.length;
    expect(fired.slice(0, 2)).toEqual([1, 2]);
    // Not before their point on the schedule.
    expect(at[0]).toBeGreaterThanOrEqual(29);
    expect(at[1]).toBeGreaterThanOrEqual(59);
    await sleep(200);
    expect(fired).toHaveLength(after);
  });
});
