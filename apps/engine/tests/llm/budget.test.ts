/**
 * The daily spend cap.
 *
 * `max_daily_cost_usd` described a budget for the whole of Phase 1 while nothing recorded spend and
 * nothing stopped a turn. Recording came first; this is the half that stops, and every test here is
 * about it failing in the safe direction — a cap that cannot see part of the spend must say so, not
 * quietly treat the invisible part as free.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { checkBudget, todaysVerdict } from "@/modules/llm/budget.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { startOfLocalDay } from "@/commons/clock.ts";

const spend = (usd: number, unpricedRequests = 0, tokens = 0) => ({
  usd,
  unpricedRequests,
  requests: 10,
  inputTokens: tokens,
  outputTokens: 0,
});

/** Every existing test is about the dollar cap, so the token cap is off in all of them. */
const NO_TOKEN_CAP = 0;

describe("checkBudget", () => {
  test("no cap means no opinion", () => {
    // Zero is the default, and it means off rather than unimplemented.
    expect(checkBudget({ spend: spend(999), capUsd: 0, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 })).toEqual({
      action: "allow",
    });
  });

  test("under the cap and under the threshold is silent", () => {
    expect(checkBudget({ spend: spend(1), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 })).toEqual({
      action: "allow",
    });
  });

  test("crossing the threshold warns without stopping", () => {
    const verdict = checkBudget({ spend: spend(8.5), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 });
    expect(verdict.action).toBe("allow");
    expect("warn" in verdict && verdict.warn).toContain("85%");
  });

  test("reaching the cap refuses, and says what to do", () => {
    const verdict = checkBudget({ spend: spend(10), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 });
    expect(verdict.action).toBe("refuse");
    expect("message" in verdict && verdict.message).toContain("max_daily_cost_usd");
  });

  test("exactly at the cap counts as reached", () => {
    // `>=`, not `>`. A cap of ten that allows the call taking you to ten and one is a cap of eleven.
    expect(checkBudget({ spend: spend(10.0), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 }).action).toBe(
      "refuse",
    );
  });

  test("unpriced calls are named in both messages", () => {
    // The figure omits them by construction — `UsageStore` records an unpriced model as NULL rather
    // than 0 precisely so a day of them cannot sum to "spent nothing". A cap that cannot see part of
    // the spend has to say so, or somebody reads the total as complete.
    const warned = checkBudget({ spend: spend(9, 4), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 });
    expect("warn" in warned && warned.warn).toContain("no published price");

    const refused = checkBudget({ spend: spend(11, 4), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 });
    expect("message" in refused && refused.message).toContain("no published price");
  });

  test("no unpriced calls means no caveat", () => {
    const verdict = checkBudget({ spend: spend(9, 0), capUsd: 10, capTokens: NO_TOKEN_CAP, alertThresholdPct: 80 });
    expect("warn" in verdict && verdict.warn).not.toContain("no published price");
  });
});

describe("startOfLocalDay, the cap's day", () => {
  test("the day starts where the operator lives, not at UTC midnight", () => {
    // 2026-08-13T02:00:00Z is already 09:00 in Jakarta, so the day there began at 17:00Z the day
    // before. An operator who sets a daily cap means their day.
    const now = Date.parse("2026-08-13T02:00:00Z");
    const jakarta = startOfLocalDay(now, "Asia/Jakarta");

    expect(new Date(jakarta).toISOString()).toBe("2026-08-12T17:00:00.000Z");
    expect(startOfLocalDay(now, "UTC")).toBe(Date.parse("2026-08-13T00:00:00Z"));
  });

  test("a moment just after local midnight belongs to the new day", () => {
    const now = Date.parse("2026-08-12T17:00:01Z"); // 00:00:01 in Jakarta
    expect(startOfLocalDay(now, "Asia/Jakarta")).toBe(Date.parse("2026-08-12T17:00:00Z"));
  });

  test("a moment just before local midnight belongs to the old day", () => {
    const now = Date.parse("2026-08-12T16:59:59Z"); // 23:59:59 the previous day in Jakarta
    expect(startOfLocalDay(now, "Asia/Jakarta")).toBe(Date.parse("2026-08-11T17:00:00Z"));
  });

  test("an unknown timezone falls back rather than stopping a turn", () => {
    // A cap that resets at the wrong hour is a much smaller failure than a daemon that will not
    // answer because somebody mistyped a zone.
    const now = Date.parse("2026-08-13T02:00:00Z");
    expect(startOfLocalDay(now, "Mars/Olympus_Mons")).toBe(Date.parse("2026-08-13T00:00:00Z"));
  });
});

/**
 * The cap that is never partly measured.
 *
 * The dollar cap can only see models that are in the price book. Measured on the live install over
 * twenty-four hours: `requests: 88 · unpricedRequests: 80 · usd: 1.11` — 8 of 88 calls. A daemon
 * pointed at a self-hosted gateway has no priced models at all, and there the dollar cap is not a
 * partial measure, it is nothing. Every response carries its token usage regardless.
 */
describe("the token ceiling", () => {
  const tokens = (input: number, output = 0) => ({
    usd: 0,
    unpricedRequests: 12,
    requests: 12,
    inputTokens: input,
    outputTokens: output,
  });

  test("zero means off, the same as the dollar cap", () => {
    expect(
      checkBudget({ spend: tokens(9_000_000), capUsd: 0, capTokens: 0, alertThresholdPct: 80 }),
    ).toEqual({ action: "allow" });
  });

  test("input and output are counted together", () => {
    // Both are billed and both are usage. Counting only input would let a run of long answers past
    // a cap it had already spent.
    const verdict = checkBudget({
      spend: tokens(600_000, 400_000),
      capUsd: 0,
      capTokens: 1_000_000,
      alertThresholdPct: 80,
    });
    expect(verdict.action).toBe("refuse");
  });

  test("it stops a day of unpriced calls, which is the whole point", () => {
    /**
     * The exact case the dollar cap cannot see: twelve requests, every one on a model with no
     * published price, so `usd` is 0 and a dollar cap of any size would allow this forever.
     */
    const spend = tokens(2_000_000);
    expect(spend.usd).toBe(0);
    expect(checkBudget({ spend, capUsd: 50, capTokens: 0, alertThresholdPct: 80 }).action).toBe(
      "allow",
    );

    const verdict = checkBudget({ spend, capUsd: 50, capTokens: 1_000_000, alertThresholdPct: 80 });
    expect(verdict.action).toBe("refuse");
    expect("message" in verdict && verdict.message).toContain("max_daily_tokens");
  });

  test("exactly at the cap counts as reached", () => {
    // `>=`, for the same reason the dollar cap uses it.
    expect(
      checkBudget({ spend: tokens(1_000_000), capUsd: 0, capTokens: 1_000_000, alertThresholdPct: 80 })
        .action,
    ).toBe("refuse");
  });

  test("it warns on the way up, with no dollar cap set", () => {
    const verdict = checkBudget({
      spend: tokens(850_000),
      capUsd: 0,
      capTokens: 1_000_000,
      alertThresholdPct: 80,
    });
    expect(verdict.action).toBe("allow");
    expect("warn" in verdict && verdict.warn).toContain("85%");
  });

  test("whichever cap is reached first refuses, and names itself", () => {
    // Two caps, one turn. The message has to name the one that stopped it or the operator raises
    // the wrong number and nothing changes.
    const overTokens = checkBudget({
      spend: { usd: 1, unpricedRequests: 0, requests: 5, inputTokens: 2_000_000, outputTokens: 0 },
      capUsd: 100,
      capTokens: 1_000_000,
      alertThresholdPct: 80,
    });
    expect("message" in overTokens && overTokens.message).toContain("token cap");

    const overUsd = checkBudget({
      spend: { usd: 120, unpricedRequests: 0, requests: 5, inputTokens: 10, outputTokens: 0 },
      capUsd: 100,
      capTokens: 1_000_000,
      alertThresholdPct: 80,
    });
    expect("message" in overUsd && overUsd.message).toContain("max_daily_cost_usd");
  });
});

/**
 * The verdict every caller of a model asks (`todaysVerdict`), over a real store: a coding CLI's prompts are on its own
 * account, so a day of them refuses no turn of the daemon's own models (0.8.8).
 */
describe("a coding CLI's tokens and the daily caps", () => {
  test("a day of a CLI's work over both caps refuses nothing; the same tokens on a model of the daemon's do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-budget-cli-"));
    const db = openDatabase(join(dir, "t.db"));
    try {
      await migrate(db);
      const now = Date.parse("2026-10-29T12:00:00Z");
      const store = new UsageStore(db, () => now);
      const caps = { daemon: { timezone: "UTC" }, llm: { limits: { maxDailyCostUsd: 1, maxDailyTokens: 100_000, costAlertThresholdPct: 80 } } };
      store.record({ agentId: "nix", model: "claude-sonnet-4-5", provider: "claude-code", inputTokens: 2_000_000, outputTokens: 50_000, cli: true });
      expect(todaysVerdict(store, caps, now)).toEqual({ action: "allow" });
      store.record({ agentId: "nouva", model: "claude-sonnet-4-5", provider: "default", inputTokens: 2_000_000, outputTokens: 50_000 });
      expect(todaysVerdict(store, caps, now).action).toBe("refuse");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
