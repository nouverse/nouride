/**
 * Home's second picture changes from one visit to the next: the cat that rests where the cards would be, and
 * the one that rides beside what is moving. The decision is `nextMoment`: any moment but the one shown last. The page
 * draws what it picks (`mount-home.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { QUIET, movingPoses, nextMoment } from "@/modules/home/moments";

const rolls = Array.from({ length: 200 }, (_, at) => at / 200);

describe("which moment a visit shows", () => {
  test("never the one shown last, and every other one, each as likely", () => {
    for (const last of [0, 2, 4]) {
      const shown = rolls.map((roll) => nextMoment(5, last, roll));
      expect(shown).not.toContain(last);
      expect([...new Set(shown)].sort()).toEqual([0, 1, 2, 3, 4].filter((at) => at !== last));
      for (const at of new Set(shown)) expect(shown.filter((one) => one === at).length).toBe(50);
    }
  });

  test("with nothing remembered, any of them", () => {
    expect([...new Set(rolls.map((roll) => nextMoment(5, null, roll)))].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test("what is remembered and is no moment of this set is as good as nothing: a set that got shorter, a text that is no number", () => {
    for (const stale of [5, 9, -1, 1.5, Number.NaN]) {
      expect([...new Set(rolls.map((roll) => nextMoment(5, stale, roll)))].sort()).toEqual([0, 1, 2, 3, 4]);
    }
  });

  test("stays inside the set at the roll's edges, and a set of one is that one", () => {
    expect(nextMoment(5, 4, 0.999999)).toBe(3);
    expect(nextMoment(5, 0, 0)).toBe(1);
    expect(nextMoment(5, null, 1)).toBe(4);
    expect(nextMoment(1, 0, 0.5)).toBe(0);
  });
});

describe("the moments", () => {
  test("a quiet Home has several, each its own picture and its own line", () => {
    expect(QUIET.length).toBeGreaterThanOrEqual(4);
    expect(new Set(QUIET.map((moment) => moment.pose)).size).toBe(QUIET.length);
    expect(new Set(QUIET.map((moment) => moment.line)).size).toBe(QUIET.length);
    expect(QUIET[0]).toEqual({ pose: "sleeping", line: "Your agents nap until something comes in." });
  });

  test("while missions move the cat rides, with its light on only late in the evening", () => {
    expect(movingPoses(true)).toContain("nightRide");
    expect(movingPoses(false)).not.toContain("nightRide");
    expect(movingPoses(false).length).toBeGreaterThanOrEqual(3);
    expect(new Set(movingPoses(false)).size).toBe(movingPoses(false).length);
  });
});
