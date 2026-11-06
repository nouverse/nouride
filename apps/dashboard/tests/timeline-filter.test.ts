/**
 * The Timeline's date range, as the tab clamps it.
 *
 * Four of these five used to compute the clamp inline and assert their own arithmetic — the tab's clamps were written
 * in the component, which no test imported, so deleting them left the suite green. The clamps are functions of
 * `timeline-date.ts` now, and the tab calls them.
 */

import { describe, expect, test } from "bun:test";
import { completeRange, diffInDays, getDefaultRange, latestUntil, onSinceChosen, onUntilChosen, parseLocalDate } from "@/modules/memories/timeline-date";

const TODAY = "2026-09-28";

describe("the timeline's date range", () => {
  test("by default, the last seven days up to today", () => {
    const range = getDefaultRange(parseLocalDate(TODAY));
    expect(range).toEqual({ since: "2026-09-21", until: TODAY });
    expect(diffInDays(range.since, range.until)).toBe(7);
  });

  test("From may be any day in the past, and To follows it by a week", () => {
    expect(onSinceChosen("2024-03-15", TODAY)).toEqual({ since: "2024-03-15", until: "2024-03-22" });
  });

  test("…but never past today, and From is never after today", () => {
    expect(onSinceChosen("2026-09-26", TODAY)).toEqual({ since: "2026-09-26", until: TODAY });
    expect(onSinceChosen("2026-10-05", TODAY)).toEqual({ since: TODAY, until: TODAY });
  });

  test("To may reach 31 days after From and no further, nor before From, nor past today", () => {
    expect(latestUntil("2024-03-15", TODAY)).toBe("2024-04-15");
    expect(onUntilChosen("2024-05-01", "2024-03-15", TODAY)).toBe("2024-04-15");
    expect(onUntilChosen("2024-03-01", "2024-03-15", TODAY)).toBe("2024-03-15");
    expect(onUntilChosen("2026-10-05", undefined, TODAY)).toBe(TODAY);
    expect(latestUntil("2026-09-20", TODAY)).toBe(TODAY);
    expect(latestUntil(undefined, TODAY)).toBe(TODAY);
  });

  test("Apply with an end left empty fills it: a week back from To, a week on from From, or the last week", () => {
    const today = parseLocalDate(TODAY);
    expect(completeRange(undefined, "2026-09-10", today)).toEqual({ since: "2026-09-03", until: "2026-09-10" });
    expect(completeRange("2026-09-25", undefined, today)).toEqual({ since: "2026-09-25", until: TODAY });
    expect(completeRange(undefined, undefined, today)).toEqual({ since: "2026-09-21", until: TODAY });
  });
});
