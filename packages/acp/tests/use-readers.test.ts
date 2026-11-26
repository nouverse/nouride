/**
 * Each CLI's account use, parsed into the one shape (`CliUse`) from the answer its maker sends. The answers here are
 * the shapes OpenBot and 9router read from the same addresses and methods (their code, read for this; neither copied);
 * none was captured from an account of ours yet, which is why a CLI not run on one is marked experimental.
 */

import { describe, expect, test } from "bun:test";
import { claudeSaid, claudeUse } from "../src/clis/claude-code.ts";
import { codexUse } from "../src/clis/codex.ts";
import { cursorUse } from "../src/clis/cursor.ts";
import { grokUse } from "../src/clis/grok.ts";

const AT = Date.parse("2026-11-27T10:00:00Z");

describe("an account's use, read from what its maker answers", () => {
  test("Claude: the 5-hour and weekly windows, a model's own weekly one by key or by its scope", () => {
    expect(
      claudeUse({
        five_hour: { utilization: 44, resets_at: "2026-11-27T12:00:00Z" },
        seven_day: { utilization: 12.5, resets_at: "2026-12-01T00:00:00Z" },
        seven_day_opus: { utilization: 130, resets_at: "2026-12-01T00:00:00Z" },
        seven_day_oauth_apps: null,
        extra_usage: { is_enabled: false },
        limits: [{ kind: "weekly_scoped", percent: 80, resets_at: "2026-12-02T00:00:00Z", scope: { model: { display_name: "Fable" } } }, { kind: "other", percent: 5 }],
      }),
    ).toEqual({
      limits: [
        { id: "five_hour", label: "5-hour", windows: [{ usedPercent: 44, minutes: 300, resetsAt: Date.parse("2026-11-27T12:00:00Z") }] },
        { id: "seven_day", label: "Weekly", windows: [{ usedPercent: 12.5, minutes: 10_080, resetsAt: Date.parse("2026-12-01T00:00:00Z") }] },
        // Past 100 is held at 100: a share, not a count.
        { id: "seven_day_opus", label: "Weekly, opus", models: ["opus"], windows: [{ usedPercent: 100, minutes: 10_080, resetsAt: Date.parse("2026-12-01T00:00:00Z") }] },
        { id: "weekly_fable", label: "Weekly, Fable", models: ["Fable"], windows: [{ usedPercent: 80, minutes: 10_080, resetsAt: Date.parse("2026-12-02T00:00:00Z") }] },
      ],
      // Extra usage said off: nothing goes on past a window.
      creditsLeft: false,
    });
  });

  test("Claude: with extra usage turned on, credits are left beyond the windows; and what it says while it works, in the same shape", () => {
    expect(claudeUse({ five_hour: { utilization: 100, resets_at: "2026-11-27T12:00:00Z" }, extra_usage: { is_enabled: true } })?.creditsLeft).toBe(true);
    // Not said: not known.
    expect(claudeUse({ five_hour: { utilization: 100, resets_at: "2026-11-27T12:00:00Z" } })?.creditsLeft).toBeUndefined();
    expect(claudeSaid({ _meta: { "_claude/rateLimit": { unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: 1_795_700_000 }, seven_day_opus: { utilization: 1.2, resetsAt: 1_796_000_000 }, odd_one: { utilization: 0.1, resetsAt: 1_796_000_000 } } } } })).toEqual({
      limits: [
        { id: "five_hour", label: "5-hour", windows: [{ usedPercent: 44, minutes: 300, resetsAt: 1_795_700_000_000 }] },
        { id: "seven_day_opus", label: "Weekly, opus", models: ["opus"], windows: [{ usedPercent: 100, minutes: 10_080, resetsAt: 1_796_000_000_000 }] },
        { id: "odd_one", label: "odd one", windows: [{ usedPercent: 10, minutes: null, resetsAt: 1_796_000_000_000 }] },
      ],
    });
  });

  test("Codex: the short window and the weekly one, their lengths in minutes, and whether credits are left", () => {
    expect(
      codexUse({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 18_000, reset_at: 1_795_700_000 }, secondary_window: { used_percent: 9, limit_window_seconds: 604_800, reset_at: 1_796_000_000 } },
        credits: { has_credits: false },
      }),
    ).toEqual({
      limits: [{ id: "codex", label: "Codex", windows: [{ usedPercent: 61, minutes: 300, resetsAt: 1_795_700_000_000 }, { usedPercent: 9, minutes: 10_080, resetsAt: 1_796_000_000_000 }] }],
      creditsLeft: false,
    });
  });

  test("Cursor: the plan used this billing cycle, split into auto and named models where Cursor splits it", () => {
    const cycle = { billingCycleStart: String(AT - 30 * 86_400_000), billingCycleEnd: String(AT) };
    expect(cursorUse({ ...cycle, planUsage: { totalPercentUsed: 37.5 } })).toEqual({
      limits: [{ id: "total", label: "Plan", windows: [{ usedPercent: 37.5, minutes: 43_200, resetsAt: AT }] }],
    });
    expect(cursorUse({ ...cycle, planUsage: { totalPercentUsed: 40, autoPercentUsed: 20, apiPercentUsed: 60 } })?.limits.map((limit) => [limit.id, limit.windows[0]!.usedPercent])).toEqual([
      ["total", 40],
      ["auto", 20],
      ["api", 60],
    ]);
  });

  test("Grok: the plan's credits this period, said in percent or as cents used of a monthly limit", () => {
    const period = { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-24T00:00:00Z", end: "2026-12-01T00:00:00Z" };
    expect(grokUse({ config: { currentPeriod: period, creditUsagePercent: 25 } })).toEqual({
      limits: [{ id: "credits", label: "Plan credits", windows: [{ usedPercent: 25, minutes: 10_080, resetsAt: Date.parse("2026-12-01T00:00:00Z") }] }],
    });
    expect(grokUse({ config: { currentPeriod: period, used: { val: 300 }, monthlyLimit: { val: 1_200 } } })?.limits[0]!.windows[0]!.usedPercent).toBe(25);
  });

  test("an answer that says nothing of the kind is no use, not a failure", () => {
    for (const read of [claudeUse, codexUse, cursorUse, grokUse]) {
      expect(read(null)).toBeNull();
      expect(read({ error: "unauthorized" })).toBeNull();
    }
    // A limit of none is no share: nothing to divide by.
    expect(grokUse({ config: { used: { val: 5 }, monthlyLimit: { val: 0 } } })).toBeNull();
  });
});
