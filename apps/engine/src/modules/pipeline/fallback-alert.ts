/**
 * What a turn that fell back to one of `[llm] fallbacks` tells the operator: once an outage, not once a turn.
 *
 * A provider down at three in the morning falls back on every turn until it is up, and an alert per turn — or per
 * five-minute cooldown — is the channel muted by four. One alert per model and profile while it keeps failing; an hour
 * without a fallback from it ends the outage, and the next one is said again. What is the operator's to fix — a model
 * not served, a key refused, a balance spent — carries the classifier's hint.
 */

import type { LLMFailure, LoadedAgent } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";

/** How long a model that fell back counts as still down: an hour without falling back from it ends its outage. */
const OUTAGE_QUIET_MS = 60 * 60_000;

export class FallbackOutages {
  private readonly lastFellBack = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether this fallback starts an outage — the first from this model in an hour — and it is counted either way. */
  starts(profile: string, model: string): boolean {
    const key = `${profile}\u0000${model}`;
    const now = this.now();
    const last = this.lastFellBack.get(key);
    this.lastFellBack.set(key, now);
    return last === undefined || now - last >= OUTAGE_QUIET_MS;
  }
}

export function alertOnFallback(
  outages: FallbackOutages,
  notifier: Pick<Notifier, "alert"> | undefined,
  agent: LoadedAgent,
): (info: { from: string; fromProfile: string; to: string; toProfile: string; failure: LLMFailure }) => void {
  return ({ from, fromProfile, to, toProfile, failure }) => {
    if (!outages.starts(fromProfile, from)) return;
    void notifier?.alert(
      `fallback:${fromProfile}:${from}`,
      `${agent.config.id}: ${from} on ${fromProfile} failed (${failure.class}), so ${to} on ${toProfile} is answering until it is back.` +
        (failure.alertOperator ? ` ${failure.operatorHint}` : ""),
    );
  };
}
