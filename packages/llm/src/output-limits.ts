/**
 * How many tokens one reply may produce, when neither the agent nor the operator has said.
 *
 * A flat 8192 cut a live turn in half (2026-10-21): a `write` of a long document streamed its content as arguments,
 * stopped at exactly 8192 output tokens three calls in a row, and every one arrived as JSON that did not parse. The
 * models that agent runs on publish limits four to sixteen times that.
 *
 * Each figure is the **floor of its family**, never the top of it — the same rule as the context windows in
 * `tokens.ts`: a cap above what a model accepts is a refused request, a cap below it only a shorter reply. 32,000 is
 * at or under every member matched, from the vendors' own model pages:
 * - Claude 4.x and 5.x: Opus 4 and 4.1 accept 32,000 (the lowest); Sonnet 4/4.5, Haiku 4.5 and Opus 4.5 64,000;
 *   Opus 4.6 on, Sonnet 4.6 on and Haiku 5.5 128,000. Claude 3.x is left out — its Haiku takes 4,096.
 * - Gemini 2.5 and 3.x, Pro and Flash: 65,536. Gemini 2.0 and earlier are left out — 2.0 Flash takes 8,192.
 * - GPT-5 and its point releases: 128,000. `gpt-5-chat` is left out — it takes 16,384.
 *
 * Anything else keeps `DEFAULT_OUTPUT_TOKENS`, the cap every model had before this table.
 */

import { normalizeModelId } from "./tokens.ts";

const OUTPUT_LIMITS: { pattern: RegExp; tokens: number }[] = [
  { pattern: /^claude-(opus|sonnet|haiku)-[45]/, tokens: 32_000 },
  { pattern: /^gemini-(2\.5|[3-9])/, tokens: 32_000 },
  { pattern: /^gpt-5(?!.*-chat)/, tokens: 32_000 },
];

const DEFAULT_OUTPUT_TOKENS = 8192;

/** The output cap for `model`, and whether the table knew it — a routing prefix (`nougate:`, `vendor/`) is ignored. */
export function outputLimitInfo(model: string): { tokens: number; known: boolean } {
  const normalized = normalizeModelId(model);
  const match = OUTPUT_LIMITS.find((entry) => entry.pattern.test(normalized));
  return match ? { tokens: match.tokens, known: true } : { tokens: DEFAULT_OUTPUT_TOKENS, known: false };
}
