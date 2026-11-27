/**
 * A model that fell back stays fallen back for a while (`HOLD_MS`): the agent's next turns start on the pair that
 * answered, rather than on the model that failed. Before, a turn's fallback was the turn's alone: each next message
 * asked the failed model first, waited out its retries (twenty seconds and more through a gateway trying its accounts),
 * and fell back again, while the operator had been told the fallback "is answering until it is back".
 *
 * Asked again once the hold is over, at the next turn: answering, it is no longer held; failing, it is held anew. One
 * daemon's memory: a restart asks the agent's own model first, as a first turn would.
 *
 * And what the person is told: the first fall of an outage, the model that takes over is asked to say so in one
 * sentence of its own (`fallbackNote`) — not on an agent open to everyone, whose strangers are told nothing of the
 * models behind it.
 */

import type { LLMError } from "@nouride/shared";

/** How long a model that could not answer is passed over for the fallback that did. */
export const HOLD_MS = 10 * 60_000;

interface Pair {
  profile: string;
  model: string;
}

interface Hold {
  to: Pair;
  until: number;
}

const keyOf = (agentId: string, pair: Pair) => `${agentId}\u0000${pair.profile}\u0000${pair.model}`;

export class FallbackHolds {
  private readonly held = new Map<string, Hold>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The pair a turn of this agent starting on `from` starts on instead, while `from` is held; else null. */
  heldFor(agentId: string, from: Pair): (Pair & { until: number }) | null {
    const hold = this.held.get(keyOf(agentId, from));
    return hold && this.now() < hold.until ? { ...hold.to, until: hold.until } : null;
  }

  /**
   * A turn of this agent fell back from `from` to `to`: `from` is held for `HOLD_MS`. `first`: no outage of it was
   * held before, or it answered since — what the person is told of; a hold that ran out and failed again is the same.
   */
  fellBack(agentId: string, from: Pair, to: Pair): { first: boolean } {
    const key = keyOf(agentId, from);
    const first = !this.held.has(key);
    this.held.set(key, { to, until: this.now() + HOLD_MS });
    return { first };
  }

  /** The model answered a call of this agent's: held no longer. */
  answered(agentId: string, pair: Pair): void {
    this.held.delete(keyOf(agentId, pair));
  }
}

/** Why a model could not answer, in words for the model taking over — never the person's to read as it is. */
export function failedBecause(failureClass: string, upstream: LLMError["upstream"] | undefined, profile: string): string {
  if (failureClass === "auth" && upstream?.tried?.length) return `the accounts ${profile} tried for it (${upstream.tried.join(", ")}) were refused`;
  const words: Record<string, string> = {
    auth: "its provider refused the key",
    billing: "its provider is out of credit",
    transient: "its provider is down",
    rate_limit: "it is rate-limited",
    overloaded: "it is overloaded",
    model_not_found: "it is not served",
  };
  return words[failureClass] ?? "it failed";
}

/**
 * The note the model taking over reads once, on the call it takes over: what failed and why, from the daemon, so the
 * person hears it from the agent in their own language rather than meeting a different voice without a word.
 */
export function fallbackNote(from: string, to: string, why: string): string {
  return (
    `[harness] ${from} could not answer just now (${why}), so you, ${to}, are carrying on with this turn as this ` +
    `agent's fallback. Begin the next thing you say to the person with one short sentence, in their language and your ` +
    `own voice, saying that ${from} ran into a problem and you are carrying on with ${to}; then go on with the work. ` +
    `Say it this once.`
  );
}
