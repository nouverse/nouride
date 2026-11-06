/**
 * The daily spend cap, and the one thing it must never do.
 *
 * `max_daily_cost_usd` described a budget for the whole of Phase 1 while nothing recorded spend and
 * nothing enforced it — the config value read like a guarantee and was a decoration. Recording came
 * first; this is the half that stops.
 *
 * ## It must not fail open
 *
 * Every way this could be wrong resolves the same direction. An unpriced model contributes nothing to
 * the total, so a day of unpriced calls sums to zero and a naive check would let it run forever —
 * which is why `UsagePort` records those as `NULL` rather than `0`, and why the count of them travels
 * with the figure. A cap that cannot see part of the spend says so instead of implying it covered
 * everything.
 *
 * ## Which is why there are two caps
 *
 * Saying so is not the same as stopping. Measured on the live install over twenty-four hours:
 * `requests: 88 · unpricedRequests: 80 · usd: 1.11` — the dollar figure covered 8 of 88 calls,
 * and six agents plus an unattended scheduler shared a brake that could not see the rest. A daemon
 * pointed at a self-hosted gateway has *no* priced models at all, and there the dollar cap is not a
 * partial measure, it is nothing.
 *
 * `max_daily_tokens` is the one that always applies: every response carries its token usage whether
 * or not anybody published a price for the model. Whichever cap is reached first refuses the turn,
 * and neither is a substitute for the other — one is enforceable everywhere and says nothing about
 * money, the other says exactly what you will spend on the models it knows about.
 *
 * ## The day starts where the operator says
 *
 * Not at UTC midnight. An operator in Jakarta who sets a daily cap means their day, and a cap that
 * resets at seven in the morning local time is a cap that surprises them once and then gets removed.
 */

import { startOfLocalDay } from "@/commons/clock.ts";

export interface SpendSnapshot {
  usd: number;
  unpricedRequests: number;
  requests: number;
  /** Counted for every request, priced or not, which is what makes the token cap enforceable. */
  inputTokens: number;
  outputTokens: number;
}

export type BudgetVerdict =
  | { action: "allow" }
  /** Over the cap. The turn is refused before the provider is called. */
  | { action: "refuse"; message: string }
  /**
   * Under the cap but past `cost_alert_threshold_pct` of it: how far, and of which cap — what the operator is told,
   * once a day at the threshold and once at 95% (`spend-alerts.ts`).
   */
  | { action: "allow"; warn: string; pct: number; cap: "usd" | "tokens" };

/**
 * Decide whether a turn may spend.
 *
 * A 0 on either cap means that cap is off, which is the default for both and is honest: nothing is
 * enforced unless somebody asked for it. With both set, whichever is reached first refuses.
 */
export function checkBudget(input: {
  spend: SpendSnapshot;
  capUsd: number;
  capTokens: number;
  alertThresholdPct: number;
}): BudgetVerdict {
  const { usd, unpricedRequests, inputTokens, outputTokens } = input.spend;

  /**
   * The token ceiling first, because it is the one that is never partly measured.
   *
   * Checked before the dollar cap so that on an install with no priced models — a self-hosted
   * gateway, which is the shape this daemon is most often pointed at — the refusal names the cap
   * that actually stopped it rather than the one that saw nothing.
   */
  const tokens = inputTokens + outputTokens;
  if (input.capTokens > 0 && tokens >= input.capTokens) {
    return {
      action: "refuse",
      message:
        `Today's usage has reached the ${input.capTokens.toLocaleString("en-US")} token cap: ` +
        `${tokens.toLocaleString("en-US")} so far across ${input.spend.requests} request(s). ` +
        `Raise max_daily_tokens or wait for the day to roll over.`,
    };
  }

  if (input.capUsd <= 0) {
    if (input.capTokens <= 0) return { action: "allow" };
    const pct = (tokens / input.capTokens) * 100;
    return pct >= input.alertThresholdPct
      ? {
          action: "allow",
          warn:
            `Today's usage is ${tokens.toLocaleString("en-US")} of ` +
            `${input.capTokens.toLocaleString("en-US")} tokens (${Math.round(pct)}%).`,
          pct,
          cap: "tokens",
        }
      : { action: "allow" };
  }

  // Said in both messages below. A figure that omits an unknown number of calls is a figure people
  // make decisions on and should not.
  const caveat =
    unpricedRequests > 0
      ? ` (plus ${unpricedRequests} call(s) on a model with no published price, so the real figure is higher)`
      : "";

  if (usd >= input.capUsd) {
    return {
      action: "refuse",
      message:
        `Today's spend has reached the ${input.capUsd.toFixed(2)} USD cap: ` +
        `${usd.toFixed(4)} so far${caveat}. Raise max_daily_cost_usd or wait for the day to roll over.`,
    };
  }

  const pct = (usd / input.capUsd) * 100;
  if (pct >= input.alertThresholdPct) {
    return {
      action: "allow",
      warn:
        `Today's spend is ${usd.toFixed(4)} of ${input.capUsd.toFixed(2)} USD ` +
        `(${Math.round(pct)}%)${caveat}.`,
      pct,
      cap: "usd",
    };
  }

  return { action: "allow" };
}

/** What `todaysVerdict` reads of the config: the caps, and the zone a day is measured in. */
interface Caps {
  daemon: { timezone: string };
  llm: { limits: { maxDailyCostUsd: number; maxDailyTokens: number; costAlertThresholdPct: number } };
}

/**
 * Today's spend against both caps — the one reading every caller of a model shares.
 *
 * A turn and a scheduled job checked it, and the nightly pass wrote the same computation out again; the rest of the
 * calls checked nothing — `/compact`, the compaction after a reply, a reflection pass, the memory pass's questions for
 * forgetting and tags, an embedding catch-up — so once a cap was reached they went on spending. Each
 * asks here now, and each is refused, or skips its work, the same way.
 */
export function todaysVerdict(usage: { since(from: number): SpendSnapshot } | undefined, config: Caps, now: number = Date.now()): BudgetVerdict {
  if (!usage) return { action: "allow" };
  return checkBudget({
    spend: usage.since(startOfLocalDay(now, config.daemon.timezone)),
    capUsd: config.llm.limits.maxDailyCostUsd,
    // The cap that applies whether or not anybody published a price for the model in use — see the header.
    capTokens: config.llm.limits.maxDailyTokens,
    alertThresholdPct: config.llm.limits.costAlertThresholdPct,
  });
}
