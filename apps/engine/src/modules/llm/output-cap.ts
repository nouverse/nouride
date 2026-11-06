/**
 * The `max_tokens` one request to the model carries.
 *
 * A number someone wrote wins: the agent's `[llm] max_tokens`, else `[llm.defaults] max_tokens`. Neither written —
 * `0`, the shipped default — is "by model": the model's own figure from `outputLimitInfo` (`@nouride/llm`), 8192 for
 * a model it does not know. Then `[llm.limits] max_tokens_per_turn` over all of it, the operator's ceiling — which is
 * a per-request cap, not a per-turn total, despite the name: it is applied to every call a turn makes.
 *
 * The ceiling's default is 32,000, the table's own figure, so it never cuts a model-aware cap short; at 16,384 it did,
 * silently, and a raised table would have bought nothing.
 */

import { outputLimitInfo } from "@nouride/llm";

export function outputCap(declared: number, model: string, ceiling: number): number {
  const chosen = declared > 0 ? declared : outputLimitInfo(model).tokens;
  return Math.min(chosen, ceiling);
}

/**
 * The room a turn plans to leave for a reply when it sizes the history: what replies were sized for before the cap
 * became the model's own. A reply may still use the whole cap — the request asks for it — and the compaction limit is
 * low enough under each known window that the two fit together (`tests/llm/output-limit.test.ts`).
 */
const PLANNED_OUTPUT_TOKENS = 8_192;

/** What a turn leaves for the reply when it sizes the history: the request's cap, at most `PLANNED_OUTPUT_TOKENS`. */
export function plannedOutputTokens(cap: number): number {
  return Math.min(cap, PLANNED_OUTPUT_TOKENS);
}
