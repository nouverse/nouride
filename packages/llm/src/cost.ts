/**
 * Cost estimation for the daily budget — §10.2 SPEC.
 *
 * A built-in price book, because the alternative is a pricing API call on every turn
 * to compute a number used for a spend cap. Prices drift, so `unpriced` is reported
 * honestly rather than guessed at: a budget that silently under-counts is worse than
 * one that says it does not know.
 *
 * ## The rows
 *
 * Each row is one vendor's list price for exact model ids, with the page it was read from and the day it was read.
 * Exact, because a pattern per family priced models nobody listed: `/^gpt-5/` charged every gpt-5.x one price while
 * the page lists them up to twenty-four times apart, and a 3.x Flash pattern gave an unlisted 3.7 Flash a plausible
 * rate. An id is a row's when it is the row's id, or that id followed by a snapshot date (`-20250514`, `-2025-08-07`)
 * or a gateway's thinking level (`-high`, `-thinking`); `.` and `-` are one separator, because Copilot writes
 * `claude-opus-4.6` for Anthropic's `claude-opus-4-6`. Anything else is unpriced — which is what a model released
 * after this table has to be (invariant #4).
 *
 * A price the vendor has said will change on a date is two rows, each with its span, and a call is priced by when it
 * was made. A long-context tier prices the whole request at its rates once the request's input passes the threshold,
 * as each vendor bills it. A cache read is the row's own cached price: the vendors discount it from a half to a
 * fortieth, so one rate for all of them was a number nobody had looked up.
 *
 * Two things this cannot see, said here rather than guessed at: a model's audio input, which Google lists higher than
 * text, is priced as text — usage does not say which tokens were which — and thinking a gateway left out of its
 * counts is not in them (`openai.ts` recovers it from `total_tokens` where a gateway reports one).
 */

import type { TokenUsage } from "@nouride/shared";
import { normalizeModelId } from "./tokens.ts";

/** USD per 1M tokens. `cachedInput` null: the page lists no cache price, so a cache read is charged as input. */
interface Rates {
  input: number;
  cachedInput: number | null;
  output: number;
}

export interface ModelPrice extends Rates {
  /** Past this many input tokens in one request, the whole request is priced at `long`. */
  long?: Rates & { above: number };
  /** The vendor's pricing page, and the day these numbers were read from it. */
  source: string;
  asOf: string;
}

interface PriceRow extends ModelPrice {
  /** As the vendor spells them. */
  ids: readonly string[];
  /** The span the price holds for, UTC days: from `from`, until the start of `until`. */
  from?: string;
  until?: string;
}

const ANTHROPIC = { source: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: "2026-10-17" };
const OPENAI = { source: "https://developers.openai.com/api/docs/pricing", asOf: "2026-10-17" };
const GOOGLE = { source: "https://ai.google.dev/gemini-api/docs/pricing", asOf: "2026-10-17" };

type Vendor = typeof ANTHROPIC;
type Tuple = readonly [input: number, cachedInput: number | null, output: number];

const rates = ([input, cachedInput, output]: Tuple): Rates => ({ input, cachedInput, output });

function row(vendor: Vendor, ids: readonly string[], price: Tuple, extra: { long?: [number, Tuple]; from?: string; until?: string } = {}): PriceRow {
  return {
    ids,
    ...rates(price),
    ...(extra.long ? { long: { above: extra.long[0], ...rates(extra.long[1]) } } : {}),
    ...(extra.from ? { from: extra.from } : {}),
    ...(extra.until ? { until: extra.until } : {}),
    ...vendor,
  };
}

/** OpenAI's long-context tier starts past this many input tokens. */
const OPENAI_LONG = 272_000;
/** Google's, on the Pro models. */
const GEMINI_LONG = 200_000;

const PRICE_BOOK: readonly PriceRow[] = [
  row(ANTHROPIC, ["claude-fable-5-1"], [10, 0.25, 50]),
  row(ANTHROPIC, ["claude-fable-5"], [10, 1, 50]),
  row(ANTHROPIC, ["claude-opus-5-5"], [4, 0.2, 20]),
  row(ANTHROPIC, ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"], [5, 0.5, 25]),
  // Retired on the Claude API; still served on Bedrock and Google Cloud.
  row(ANTHROPIC, ["claude-opus-4-1", "claude-opus-4-0", "claude-opus-4"], [15, 1.5, 75]),
  row(ANTHROPIC, ["claude-sonnet-5-5"], [2, 0.1, 10]),
  row(ANTHROPIC, ["claude-sonnet-5"], [2, 0.2, 10]),
  row(ANTHROPIC, ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-0", "claude-sonnet-4"], [3, 0.3, 15]),
  // Priced by prompt length, cache reads and writes included in it.
  row(ANTHROPIC, ["claude-haiku-5-5"], [0.1, 0.01, 0.5], { long: [100_000, [0.5, 0.05, 2.5]] }),
  row(ANTHROPIC, ["claude-haiku-4-5"], [1, 0.1, 5]),
  row(ANTHROPIC, ["claude-3-5-haiku"], [0.8, 0.08, 4]),

  row(OPENAI, ["gpt-6-astra"], [10, 1, 50], { long: [OPENAI_LONG, [20, 2, 75]] }),
  row(OPENAI, ["gpt-6.1-sol"], [2, 0.1, 10], { long: [OPENAI_LONG, [4, 0.2, 15]] }),
  row(OPENAI, ["gpt-6-sol"], [2, 0.2, 10], { long: [OPENAI_LONG, [4, 0.4, 15]] }),
  row(OPENAI, ["gpt-6-luna"], [0.1, 0.01, 0.5], { long: [OPENAI_LONG, [0.2, 0.02, 0.75]] }),
  // On a promotion "through at least 2026-11-21", the page says, without saying what follows it.
  row(OPENAI, ["gpt-5.6-sol"], [4, 0.4, 20], { long: [OPENAI_LONG, [8, 0.8, 30]] }),
  row(OPENAI, ["gpt-5.6-terra"], [2, 0.2, 12], { long: [OPENAI_LONG, [4, 0.4, 18]] }),
  row(OPENAI, ["gpt-5.6-luna"], [0.2, 0.02, 1.2], { long: [OPENAI_LONG, [0.4, 0.04, 1.8]] }),
  row(OPENAI, ["gpt-5.5"], [5, 0.5, 30], { long: [OPENAI_LONG, [10, 1, 45]] }),
  row(OPENAI, ["gpt-5.5-pro"], [30, null, 180], { long: [OPENAI_LONG, [60, null, 270]] }),
  row(OPENAI, ["gpt-5.4"], [2.5, 0.25, 15], { long: [OPENAI_LONG, [5, 0.5, 22.5]] }),
  row(OPENAI, ["gpt-5.4-mini"], [0.75, 0.075, 4.5]),
  row(OPENAI, ["gpt-5.4-nano"], [0.2, 0.02, 1.25]),
  row(OPENAI, ["gpt-5.4-pro"], [30, null, 180], { long: [OPENAI_LONG, [60, null, 270]] }),
  row(OPENAI, ["gpt-5.3-codex", "gpt-5.2"], [1.75, 0.175, 14]),
  row(OPENAI, ["gpt-5.2-pro"], [21, null, 168]),
  row(OPENAI, ["gpt-5.1", "gpt-5"], [1.25, 0.125, 10]),
  row(OPENAI, ["gpt-5-mini"], [0.25, 0.025, 2]),
  row(OPENAI, ["gpt-5-nano"], [0.05, 0.005, 0.4]),
  row(OPENAI, ["gpt-5-pro"], [15, null, 120]),
  row(OPENAI, ["o3-pro"], [20, null, 80]),
  row(OPENAI, ["o3"], [2, 0.5, 8]),
  row(OPENAI, ["o3-mini"], [1.1, 0.55, 4.4]),
  row(OPENAI, ["o4-mini"], [1.1, 0.275, 4.4]),
  row(OPENAI, ["gpt-4.1"], [2, 0.5, 8]),
  row(OPENAI, ["gpt-4.1-mini"], [0.4, 0.1, 1.6]),
  row(OPENAI, ["gpt-4.1-nano"], [0.1, 0.025, 0.4]),
  row(OPENAI, ["gpt-4o"], [2.5, 1.25, 10]),
  row(OPENAI, ["gpt-4o-mini"], [0.15, 0.075, 0.6]),

  row(GOOGLE, ["gemini-4-argon"], [2, 0.1, 10], { until: "2026-12-01" }),
  row(GOOGLE, ["gemini-4-argon"], [4, 0.2, 20], { from: "2026-12-01" }),
  row(GOOGLE, ["gemini-3.8-flash", "gemini-3.6-flash"], [0.75, 0.075, 3.75], { until: "2027-01-01" }),
  row(GOOGLE, ["gemini-3.8-flash", "gemini-3.6-flash"], [1.5, 0.15, 7.5], { from: "2027-01-01" }),
  // The page calls it legacy. Not 3.7 Flash, 3.5 Flash or plain 3 Flash, which it does not list at all.
  row(GOOGLE, ["gemini-3-flash-preview"], [0.5, 0.05, 3]),
  row(GOOGLE, ["gemini-3.5-flash-lite"], [0.3, 0.03, 2.5]),
  row(GOOGLE, ["gemini-3.1-flash-lite"], [0.25, 0.025, 1.5]),
  row(GOOGLE, ["gemini-3.1-pro-preview"], [2, 0.2, 12], { long: [GEMINI_LONG, [4, 0.4, 18]] }),
  row(GOOGLE, ["gemini-2.5-pro"], [1.25, 0.125, 10], { long: [GEMINI_LONG, [2.5, 0.25, 15]] }),
  row(GOOGLE, ["gemini-2.5-flash"], [0.3, 0.03, 2.5]),
  row(GOOGLE, ["gemini-2.5-flash-lite"], [0.1, 0.01, 0.4]),
];

/** What may follow a row's id and still be that model: a snapshot date, then a gateway's thinking level. */
const SUFFIX = /^(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?(?:-(?:minimal|low|medium|high|xhigh|max|thinking))?$/;

const canonical = (id: string) => id.toLowerCase().replaceAll(".", "-");

function names(row: PriceRow, id: string): boolean {
  return row.ids.some((known) => {
    const base = canonical(known);
    return id === base || (id.startsWith(`${base}-`) && SUFFIX.test(id.slice(base.length)));
  });
}

function holdsOn(row: PriceRow, at: number): boolean {
  const day = new Date(at).toISOString().slice(0, 10);
  return (!row.from || day >= row.from) && (!row.until || day < row.until);
}

/** The list price of `model` on the day `at` falls in, or null when no row names it. */
export function priceFor(model: string, at: number = Date.now()): ModelPrice | null {
  // Same prefix problem as the context window: `antigravity:claude-sonnet-4-6` is priced
  // like the Sonnet it is, not reported as unpriced.
  const id = canonical(normalizeModelId(model));
  const found = PRICE_BOOK.find((entry) => names(entry, id) && holdsOn(entry, at));
  if (!found) return null;
  const { ids: _ids, from: _from, until: _until, ...price } = found;
  return price;
}

export interface CostEstimate {
  usd: number;
  /** True when the model is not in the price book — `usd` is 0 and means nothing. */
  unpriced: boolean;
  /** The day the price used was read from the vendor's page. */
  asOf?: string;
}

/**
 * What a cache write costs, as a multiple of input: Anthropic's 5-minute write, the only cache write a provider here
 * reports (`cacheCreationInputTokens`). A quarter *more* than an uncached token, which is the part that is easy to
 * forget: caching that never gets read is 25% worse than not caching, so a cost figure that priced writes at par
 * would show a misplaced breakpoint as a saving. Same page, same day as the Anthropic rows.
 */
const CACHE_WRITE_RATE = 1.25;

export function estimateCost(model: string, usage: TokenUsage, at: number = Date.now()): CostEstimate {
  const price = priceFor(model, at);
  if (!price) return { usd: 0, unpriced: true };
  const rate = price.long && usage.inputTokens > price.long.above ? price.long : price;

  /**
   * Cache reads and writes are both inside `inputTokens` — each provider normalises to that on the
   * way in, see `TokenUsage` — so they are subtracted out and repriced at their own rates.
   *
   * `?? 0` is the honest default here and it is a *silence*, not a zero: a provider that reports no
   * cache field gets charged full price for every token, which is the same answer as before this
   * existed. Erring the other way — assuming a hit — would understate spend against the daily cap.
   *
   * Clamped as a pair, and against the running remainder rather than each against the input total: a
   * proxy is free to report counts that do not add up, and two independent clamps would let their sum
   * exceed the input and drive the billable count negative, which credits the budget.
   */
  const cached = clamp(usage.cachedInputTokens, usage.inputTokens);
  const written = clamp(usage.cacheCreationInputTokens, usage.inputTokens - cached);
  const billableInput = usage.inputTokens - cached - written;

  const usd =
    (billableInput / 1_000_000) * rate.input +
    (cached / 1_000_000) * (rate.cachedInput ?? rate.input) +
    (written / 1_000_000) * rate.input * CACHE_WRITE_RATE +
    (usage.outputTokens / 1_000_000) * rate.output;

  return { usd, unpriced: false, asOf: price.asOf };
}

function clamp(reported: number | undefined, ceiling: number): number {
  return Math.max(0, Math.min(reported ?? 0, Math.max(0, ceiling)));
}
