/**
 * What a conversation's provider counts for each token the estimator counts — learned from what the
 * provider reported, and applied wherever a limit is checked against an estimate (M8).
 *
 * The estimator counts characters (`tokens.ts` in `@nouride/llm`), and some text tokenizes far denser
 * than it guesses: a pasted log of timestamps and ids came out at 2.3x the estimate on the box, so an
 * agent limited to 16k compacted at 27k. Only the compaction after a reply corrected for it, from the
 * last request's billed input. The window a turn starts with and the guard before every round of its
 * tool loop used the raw estimate with the billed count in hand, so a log-heavy turn carried 2.3x the
 * tool output it was allowed before it trimmed any.
 *
 * Measured, never assumed: what the provider reported as a request's input, over what we estimated for
 * that same request — prompt, tool schemas and messages. Nothing else is learned from. A provider that
 * reported nothing (Nougate's silence, filled in by `fillMissingUsage` and flagged `estimated`) teaches
 * nothing, and the scale stays where it was.
 *
 * Applied by dividing. A limit is in the provider's tokens — a window, `compact_at_tokens` — and the
 * history is measured in the estimator's, so the limit divided by the scale is how far the estimate may
 * go (`ceilingsAt` in `executor/prepare.ts`).
 */

/**
 * Never below one: the estimator is biased high on prose on purpose, and a provider counting a request
 * as smaller than we thought is no reason to carry more. Never above four: one token per character is
 * four times the estimate, and a ratio past it is a provider reporting something other than this request.
 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;

/** What the provider counted per estimated token for one request, within the bounds above — undefined when either side is missing. */
export function measuredScale(estimated: number, reported: number): number | undefined {
  if (!(estimated > 0) || !(reported > 0)) return undefined;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, reported / estimated));
}

/**
 * Conversations remembered at once. Past it, the one measured longest ago gives way — every table the
 * daemon keeps in memory has a ceiling, because each one that did not grew without bound once.
 */
const MAX_CONVERSATIONS = 1_000;

/**
 * The scale each conversation last measured, so its next turn starts from it — and each agent's, so a new conversation
 * does too.
 *
 * A turn learns its own from its first call, and its guard uses that from the second round on. What
 * this keeps is the start of the *next* turn: the window and the compaction decided before its first
 * call, which would otherwise be decided on the raw estimate every time.
 *
 * A conversation that has measured nothing yet — a new chat, or any chat after a restart — starts from its agent's:
 * what the agent's last request that its prompt and tools outweighed measured. That part is the same in every
 * conversation of the agent, so it is a fair start; a request a long history outweighed is not learned from for this,
 * since a log-heavy chat measures its log, not what another chat will send. Before, a new chat's first request was
 * said at the raw estimate — 31,391 tokens for a request Claude counted at 48,950 (2026-10-24) — and its window was
 * decided at it.
 *
 * In memory, per conversation and per model, on purpose. Another model is another tokenizer, so a
 * `/model` switch starts again from the estimate rather than carry a ratio measured on something else.
 * A restart starts again too — the first call measures it back — where a ratio kept on disk would
 * outlive the model and the estimator it was measured against.
 */
export class TokenScales {
  private readonly scales = new Map<string, { model: string; scale: number }>();
  private readonly agents = new Map<string, number>();

  /** The scale this conversation last measured on this model; its agent's when it never has; 1, the estimate as it is, when neither has. */
  get(sessionId: string, model: string, agentId?: string): number {
    const known = this.scales.get(sessionId);
    if (known?.model === model) return known.scale;
    return (agentId === undefined ? undefined : this.agents.get(agentKey(agentId, model))) ?? MIN_SCALE;
  }

  set(sessionId: string, model: string, scale: number): void {
    remember(this.scales, sessionId, { model, scale });
  }

  /** What a request this agent's prompt and tools outweighed measured — the start of its next new conversation. */
  setForAgent(agentId: string, model: string, scale: number): void {
    remember(this.agents, agentKey(agentId, model), scale);
  }
}

const agentKey = (agentId: string, model: string): string => `${agentId}\u0000${model}`;

/** Kept newest last, the oldest dropped past the ceiling: a Map iterates in insertion order. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= MAX_CONVERSATIONS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}
