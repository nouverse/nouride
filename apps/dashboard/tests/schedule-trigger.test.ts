/**
 * Reopening a schedule in the editor, and sending it back.
 *
 * The round trip is the whole risk. The old editor checked `kind === "interval"` — the kind is
 * `"every"` — and read `schedule.every`, a field that does not exist (it is `everyMs`). So an
 * interval job opened on the Cron tab with an empty expression, and pressing Save there rewrote a
 * working `every 15m` job into something else entirely. Nothing warned; the row simply stopped
 * running on the schedule it was created with.
 */

import { describe, expect, test } from "bun:test";
import {
  describeDraft,
  draftFromTrigger,
  triggerBody,
} from "../src/modules/schedule/lib/trigger.ts";

const TZ = "Asia/Jakarta";

describe("reading a stored trigger", () => {
  test("an interval opens on the interval tab, in the largest whole unit", () => {
    const draft = draftFromTrigger({ kind: "every", everyMs: 900_000 }, TZ);
    expect(draft.mode).toBe("interval");
    expect(draft.everyCount).toBe("15");
    expect(draft.everyUnit).toBe("m");

    // An hour is an hour, not sixty minutes — the unit the operator would have typed.
    expect(draftFromTrigger({ kind: "every", everyMs: 3_600_000 }, TZ)).toMatchObject({
      everyCount: "1",
      everyUnit: "h",
    });
    expect(draftFromTrigger({ kind: "every", everyMs: 86_400_000 }, TZ)).toMatchObject({
      everyCount: "1",
      everyUnit: "d",
    });
  });

  test("a daily cron expression opens on the friendly tab", () => {
    // Nobody should have to read `0 9 * * 1-5` back to check what they set.
    const draft = draftFromTrigger({ kind: "cron", expr: "0 9 * * 1-5", tz: TZ }, "UTC");
    expect(draft.mode).toBe("daily");
    expect(draft.time).toBe("09:00");
    expect(draft.days).toEqual([1, 2, 3, 4, 5]);
    // The job's own zone wins over the daemon's.
    expect(draft.tz).toBe(TZ);
  });

  test("an expression the builder could not have produced stays raw", () => {
    const draft = draftFromTrigger({ kind: "cron", expr: "*/10 9-17 * * *" }, TZ);
    expect(draft.mode).toBe("cron");
    expect(draft.expr).toBe("*/10 9-17 * * *");
  });

  test("a one-shot opens on the once tab", () => {
    const at = new Date(2026, 8, 20, 7, 30).getTime();
    const draft = draftFromTrigger({ kind: "at", at }, TZ);
    expect(draft.mode).toBe("once");
    expect(draft.at).toBe("2026-09-20T07:30");
  });

  test("a webhook trigger falls back to the default rather than throwing", () => {
    // Webhooks are listed on their own page, but the same form must not explode if one reaches it.
    expect(draftFromTrigger({ kind: "webhook" }, TZ).mode).toBe("interval");
    expect(draftFromTrigger(undefined, TZ).tz).toBe(TZ);
  });
});

describe("sending one back", () => {
  const base = draftFromTrigger(undefined, TZ);

  test("exactly one of every/cron/at is sent", () => {
    // The daemon refuses a body carrying two, which is the right refusal and a baffling one to meet
    // from a form that never showed you the second field.
    for (const draft of [
      { ...base, mode: "interval" as const, everyCount: "30", everyUnit: "m" as const },
      { ...base, mode: "daily" as const, time: "07:00" },
      { ...base, mode: "cron" as const, expr: "0 9 * * *" },
      { ...base, mode: "once" as const, at: "2026-09-20T07:30" },
    ]) {
      const body = triggerBody(draft);
      const named = ["every", "cron", "at"].filter((key) => key in body);
      expect(named).toHaveLength(1);
    }
  });

  test("the interval is a string the daemon parses", () => {
    expect(triggerBody({ ...base, mode: "interval", everyCount: "2", everyUnit: "h" })).toEqual({
      every: "2h",
    });
  });

  test("the daily builder writes minute-first, and no days means every day", () => {
    // Cron's field order is the one thing about it everybody gets wrong once.
    expect(triggerBody({ ...base, mode: "daily", time: "09:05", days: [] })).toEqual({
      cron: "5 9 * * *",
      tz: TZ,
    });
    expect(triggerBody({ ...base, mode: "daily", time: "17:00", days: [5, 1] })).toEqual({
      cron: "0 17 * * 1,5",
      tz: TZ,
    });
  });

  test("a one-shot keeps the operator's wall clock and names the zone", () => {
    // Resolved by the daemon in `tz`, not by the browser in whatever zone the laptop is in.
    expect(triggerBody({ ...base, mode: "once", at: "2026-09-20T07:30" })).toEqual({
      at: "2026-09-20 07:30",
      tz: TZ,
    });
  });

  test("an empty or nonsense draft sends nothing, so the form can refuse to save", () => {
    expect(triggerBody({ ...base, mode: "interval", everyCount: "" })).toEqual({});
    expect(triggerBody({ ...base, mode: "interval", everyCount: "0" })).toEqual({});
    expect(triggerBody({ ...base, mode: "cron", expr: "   " })).toEqual({});
    expect(triggerBody({ ...base, mode: "once", at: "" })).toEqual({});
  });
});

describe("the sentence under the form", () => {
  const base = draftFromTrigger(undefined, TZ);

  test("says what was set, in words", () => {
    expect(describeDraft({ ...base, mode: "interval", everyCount: "1", everyUnit: "h" })).toContain(
      "every 1 hour",
    );
    expect(describeDraft({ ...base, mode: "daily", time: "09:00", days: [1] })).toContain("Mon");
    expect(describeDraft({ ...base, mode: "daily", time: "09:00", days: [] })).toContain("every day");
  });

  test("says nothing rather than something wrong when the draft is incomplete", () => {
    expect(describeDraft({ ...base, mode: "cron", expr: "" })).toBe("—");
    expect(describeDraft({ ...base, mode: "once", at: "" })).toBe("—");
  });
});
