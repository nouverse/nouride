/**
 * What the operator hears as a day's spend nears its cap: twice a day at most — once past
 * `cost_alert_threshold_pct`, once past 95% — each naming who spent it.
 *
 * The alert rode the `[alerts]` cooldown, five minutes, so past the threshold the operator heard it again every five
 * minutes for the rest of the day, and the figure in it never said where the money went. Each step is now said once a
 * day, remembered in a file so a restart does not say it again, and the cap itself is unchanged.
 */

import { startOfLocalDay } from "@/commons/clock.ts";
import type { BudgetVerdict } from "./budget.ts";
import type { Spender } from "./usage.store.ts";

/** The second step: close enough that the next few turns may be refused. */
const NEAR_CAP_PCT = 95;

type Step = "threshold" | "near";

/** What the file keeps: the day the steps were said on, and which. */
export interface SaidToday {
  day: number;
  steps: Step[];
}

export interface SpendAlertsDeps {
  alert: (key: string, text: string) => Promise<boolean>;
  spenders: (from: number) => Spender[];
  /** Where the steps already said today are kept across a restart. */
  file?: { load(): SaidToday | null; save(said: SaidToday): void };
  timezone: () => string;
  now?: () => number;
}

function named(spenders: readonly Spender[], cap: "usd" | "tokens"): string {
  const top = spenders.filter((one) => (cap === "usd" ? one.usd > 0 : one.tokens > 0));
  if (top.length === 0) return "";
  const each = top.map((one) =>
    cap === "usd" ? `${one.agentId} on ${one.model}, ${one.usd.toFixed(2)} USD` : `${one.agentId} on ${one.model}, ${one.tokens.toLocaleString("en-US")} tokens`,
  );
  return ` Most of it: ${each.join("; ")}.`;
}

export class SpendAlerts {
  private said: SaidToday;

  constructor(private readonly deps: SpendAlertsDeps) {
    this.said = deps.file?.load() ?? { day: 0, steps: [] };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Told today's verdict: says a step it has not said today, and nothing else. */
  check(verdict: BudgetVerdict): void {
    if (!("warn" in verdict)) return;
    const now = this.now();
    const day = startOfLocalDay(now, this.deps.timezone());
    if (this.said.day !== day) this.said = { day, steps: [] };
    const step: Step = verdict.pct >= NEAR_CAP_PCT ? "near" : "threshold";
    if (this.said.steps.includes(step)) return;
    this.said = { day, steps: [...this.said.steps, step] };
    this.deps.file?.save(this.said);
    const then = step === "near" ? " At the cap, turns are refused until the day rolls over." : "";
    void this.deps.alert(`cost_${step}`, `${verdict.warn}${named(this.deps.spenders(day), verdict.cap)}${then}`);
  }
}
