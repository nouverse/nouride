import { describe, expect, test } from "bun:test";
import { CronParseError, assertTimezone, nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";

/** The instant a zone's wall clock reads a given local time — the inverse of what the parser answers. */
function jakarta(iso: string): number {
  return Date.parse(`${iso}+07:00`);
}

describe("parsing", () => {
  test("rejects the wrong number of fields", () => {
    expect(() => parseCronExpr("0 9 * *")).toThrow(CronParseError);
    expect(() => parseCronExpr("0 9 * * * *")).toThrow(CronParseError);
  });

  test("rejects out-of-range values rather than clamping them", () => {
    expect(() => parseCronExpr("60 * * * *")).toThrow(/minute must be 0-59/);
    expect(() => parseCronExpr("0 24 * * *")).toThrow(/hour must be 0-23/);
  });

  test("accepts names for month and day-of-week", () => {
    const parsed = parseCronExpr("0 9 * jan mon");
    expect(parsed.month.values.has(1)).toBe(true);
    expect(parsed.dayOfWeek.values.has(1)).toBe(true);
  });

  test("7 and 0 are both Sunday", () => {
    expect(parseCronExpr("0 9 * * 7").dayOfWeek.values.has(0)).toBe(true);
  });

  test("steps expand from a bare value to the end of the range", () => {
    expect([...parseCronExpr("5/15 * * * *").minute.values]).toEqual([5, 20, 35, 50]);
  });
});

describe("next occurrence", () => {
  test("daily at 09:00 Jakarta, from just before", () => {
    const parsed = parseCronExpr("0 9 * * *");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-18T08:59:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2026-08-18T09:00:00"));
  });

  test("daily at 09:00 Jakarta rolls to tomorrow once passed", () => {
    const parsed = parseCronExpr("0 9 * * *");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-18T09:00:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2026-08-19T09:00:00"));
  });

  test("the same expression is a different instant in a different zone", () => {
    const parsed = parseCronExpr("0 9 * * *");
    const wib = nextCronOccurrence(parsed, jakarta("2026-08-18T00:00:00"), "Asia/Jakarta");
    const utc = nextCronOccurrence(parsed, jakarta("2026-08-18T00:00:00"), "UTC");
    expect(utc - wib).toBe(7 * 60 * 60 * 1000);
  });

  test("every 15 minutes", () => {
    const parsed = parseCronExpr("*/15 * * * *");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-18T10:07:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2026-08-18T10:15:00"));
  });

  test("day-of-month and day-of-week are OR when both are restricted", () => {
    // 2026-08-15 is a Saturday. `0 9 15 * 1` must also fire on the Mondays around it.
    const parsed = parseCronExpr("0 9 15 * 1");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-15T10:00:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2026-08-17T09:00:00")); // the Monday, not the 15th of September
  });

  test("a restricted day-of-month with a wildcard day-of-week is not vetoed", () => {
    const parsed = parseCronExpr("0 9 15 * *");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-15T10:00:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2026-09-15T09:00:00"));
  });

  test("crosses a year for a February-only expression", () => {
    const parsed = parseCronExpr("0 0 29 2 *");
    const next = nextCronOccurrence(parsed, jakarta("2026-08-18T00:00:00"), "Asia/Jakarta");
    expect(next).toBe(jakarta("2028-02-29T00:00:00"));
  });

  test("an expression that can never match throws rather than sitting there looking scheduled", () => {
    expect(() => nextCronOccurrence(parseCronExpr("0 0 30 2 *"), Date.now(), "UTC")).toThrow(
      /no occurrence/,
    );
  });

  test("survives a DST spring-forward — 02:30 does not exist on that day in New York", () => {
    const parsed = parseCronExpr("30 2 * * *");
    // 2027-03-14 is the US spring-forward. The job must still land once, and move on.
    const from = Date.parse("2027-03-13T12:00:00-05:00");
    const first = nextCronOccurrence(parsed, from, "America/New_York");
    const second = nextCronOccurrence(parsed, first, "America/New_York");
    expect(second).toBeGreaterThan(first);
    // Consecutive daily occurrences across the transition are never more than two days apart.
    expect(second - first).toBeLessThan(48 * 60 * 60 * 1000);
  });

  test("the answer is always strictly after the instant asked about", () => {
    const parsed = parseCronExpr("* * * * *");
    const now = jakarta("2026-08-18T10:00:00");
    expect(nextCronOccurrence(parsed, now, "Asia/Jakarta")).toBeGreaterThan(now);
  });
});

test("an unknown timezone is refused", () => {
  expect(() => assertTimezone("Asia/Jakartaa")).toThrow(/IANA/);
  expect(() => assertTimezone("Asia/Jakarta")).not.toThrow();
});
