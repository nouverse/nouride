/**
 * A day's spend nearing its cap is said twice at most — past the threshold, past 95% — each naming who spent it, and a
 * restart does not say it again. It used to ride the `[alerts]` cooldown: every five minutes
 * for the rest of the day.
 */

import { describe, expect, test } from "bun:test";
import { checkBudget } from "@/modules/llm/budget.ts";
import { SpendAlerts, type SaidToday } from "@/modules/llm/spend-alerts.ts";

const HOUR = 60 * 60_000;
/** A UTC noon, so the local day is the same day for the whole test. */
const NOON = Date.UTC(2026, 9, 25, 12);

function alerts(start = NOON) {
  let now = start;
  const sent: { key: string; text: string }[] = [];
  let kept: SaidToday | null = null;
  const file = { load: () => kept, save: (said: SaidToday) => void (kept = said) };
  const make = () =>
    new SpendAlerts({
      alert: async (key, text) => (sent.push({ key, text }), true),
      spenders: () => [
        { agentId: "nouva", model: "sonnet", usd: 4.2, tokens: 900_000 },
        { agentId: "nox", model: "flash", usd: 0.3, tokens: 2_000_000 },
      ],
      file,
      timezone: () => "UTC",
      now: () => now,
    });
  return { sent, make, tick: (ms: number) => void (now += ms) };
}

const at = (usd: number) => checkBudget({ spend: { usd, unpricedRequests: 0, requests: 10, inputTokens: 1, outputTokens: 1 }, capUsd: 5, capTokens: 0, alertThresholdPct: 80 });

describe("the spend alerts", () => {
  test("once at the threshold however many turns follow, then once at 95%, naming who spent it", () => {
    const { sent, make, tick } = alerts();
    const spend = make();
    spend.check(at(4.1));
    tick(10 * 60_000);
    spend.check(at(4.2));
    spend.check(at(4.3));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("82%");
    expect(sent[0]!.text).toContain("Most of it: nouva on sonnet, 4.20 USD; nox on flash, 0.30 USD.");
    spend.check(at(4.8));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe("cost_near");
    expect(sent[1]!.text).toContain("At the cap, turns are refused");
    spend.check(at(4.9));
    expect(sent).toHaveLength(2);
  });

  test("a restart does not say a step again; the next day does", () => {
    const { sent, make, tick } = alerts();
    make().check(at(4.1));
    make().check(at(4.2));
    expect(sent).toHaveLength(1);
    tick(24 * HOUR);
    make().check(at(4.1));
    expect(sent).toHaveLength(2);
  });

  test("past 95% first thing, one alert — its own, not the threshold's first", () => {
    const { sent, make } = alerts();
    const spend = make();
    spend.check(at(4.9));
    spend.check(at(4.95));
    expect(sent.map((one) => one.key)).toEqual(["cost_near"]);
  });

  test("on the token cap, the spenders are named by tokens", () => {
    const { sent, make } = alerts();
    make().check(checkBudget({ spend: { usd: 0, unpricedRequests: 9, requests: 9, inputTokens: 2_500_000, outputTokens: 0 }, capUsd: 0, capTokens: 3_000_000, alertThresholdPct: 80 }));
    expect(sent[0]!.text).toContain("nouva on sonnet, 900,000 tokens");
  });
});
