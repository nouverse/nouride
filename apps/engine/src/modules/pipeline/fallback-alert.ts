/**
 * What a turn that fell back to one of `[llm] fallbacks` tells the operator: once an outage, not once a turn.
 *
 * A provider down at three in the morning falls back on every turn until it is up, and an alert per turn — or per
 * five-minute cooldown — is the channel muted by four. One alert per model and profile while it keeps failing; an hour
 * without a fallback from it ends the outage, and the next one is said again. What is the operator's to fix — a model
 * not served, a key refused, a balance spent — carries the classifier's hint.
 */

import type { LLMError, LLMFailure, LoadedAgent } from "@nouride/shared";
import { HOLD_MS } from "@/modules/llm/executor/fallback-holds.ts";
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

/**
 * What the operator is told about a failure that is theirs to fix: what to change, then the provider's own sentence
 * where it wrote one. A gateway with no account for a model says which to add; the hint alone names this install's key.
 */
export function forOperator(failure: Pick<LLMFailure, "operatorHint" | "said">): string {
  return failure.said ? `${failure.operatorHint} The provider said: "${failure.said}"` : failure.operatorHint;
}

export function alertOnFallback(
  outages: FallbackOutages,
  notifier: Pick<Notifier, "alert"> | undefined,
  agent: LoadedAgent,
): (info: { from: string; fromProfile: string; to: string; toProfile: string; failure: LLMFailure; upstream?: LLMError["upstream"] }) => void {
  return ({ from, fromProfile, to, toProfile, failure, upstream }) => {
    if (!outages.starts(fromProfile, from)) return;
    /**
     * A key refused by the accounts a gateway tried behind it, not by the gateway: this install's key to it is fine, and
     * the hint to check it sent the operator after the wrong thing (seen live: Google refused the gateway's
     * Antigravity accounts, 403, and the alert said to check the secret in `[providers.*] api_key`).
     */
    const behind = failure.class === "auth" && upstream?.tried?.length ? upstream.tried : null;
    const what = behind
      ? `failed: the accounts ${fromProfile} tried for it (${behind.join(", ")}) were refused there, not this install's key to ${fromProfile}`
      : `failed (${failure.class})`;
    void notifier?.alert(
      `fallback:${fromProfile}:${from}`,
      `${agent.config.id}: ${from} on ${fromProfile} ${what}, so ${to} on ${toProfile} is answering until it is back, and ${from} is asked again in ${HOLD_MS / 60_000} minutes.` +
        (failure.alertOperator && !behind ? ` ${forOperator(failure)}` : behind && failure.said ? ` ${fromProfile} said: "${failure.said}"` : ""),
    );
  };
}
