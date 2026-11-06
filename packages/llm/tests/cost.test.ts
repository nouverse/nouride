/**
 * The price book (`cost.ts`): exact ids, each vendor's own numbers, read from its page on a day the row names. What it
 * replaced priced by family — `/^gpt-5/` charged thirteen gpt-5.x models one price, a 3.x Flash pattern priced an
 * unlisted 3.7 Flash, and Opus was 15/75 for every generation when only the retired ones cost that.
 */

import { describe, expect, test } from "bun:test";
import { estimateCost, priceFor } from "../src/cost.ts";

const OCTOBER = Date.UTC(2026, 9, 17);
const NEXT_YEAR = Date.UTC(2027, 0, 2);
const M = 1_000_000;

describe("an id is priced by its own row", () => {
  test.each([
    // [id as a gateway or a client spells it, input, output]
    ["antigravity:gemini-3.8-flash", 0.75, 3.75],
    ["antigravity:gemini-3.8-flash-high", 0.75, 3.75],
    ["nougate/gemini-2.5-flash", 0.3, 2.5],
    ["copilot:claude-opus-4.6", 5, 25],
    ["antigravity:claude-opus-4-6-thinking", 5, 25],
    ["claude-opus-4-5-20251101", 5, 25],
    ["claude-opus-5-5", 4, 20],
    ["claude-opus-4-20250514", 15, 75],
    ["claudecode:claude-sonnet-5", 2, 10],
    ["claude-sonnet-4-6", 3, 15],
    ["codex:gpt-5.5", 5, 30],
    ["codex:gpt-5.6-luna", 0.2, 1.2],
    ["openai/gpt-5-mini", 0.25, 2],
    ["gpt-5-2025-08-07", 1.25, 10],
    ["gpt-5-pro", 15, 120],
    ["gpt-5.4-nano", 0.2, 1.25],
    ["o3-mini", 1.1, 4.4],
  ])("%s → %d in, %d out", (id, input, output) => {
    expect(priceFor(id, OCTOBER)).toMatchObject({ input, output });
  });

  test("and names the page it came from, and the day", () => {
    expect(priceFor("gemini-3.8-flash", OCTOBER)).toMatchObject({ source: "https://ai.google.dev/gemini-api/docs/pricing", asOf: "2026-10-17" });
    expect(estimateCost("claude-opus-4-6", { inputTokens: 1, outputTokens: 1 }, OCTOBER).asOf).toBe("2026-10-17");
  });
});

describe("what no row names stays unpriced", () => {
  test.each([
    "antigravity:gemini-3.7-flash",
    "gemini-3.5-flash",
    "gemini-3.8-flash-tts",
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-preview-tts",
    "gpt-5-codex",
    "o3-deep-research",
    "claude-3-5-sonnet",
    "nouverse-local-7b",
  ])("%s", (id) => {
    expect(priceFor(id, OCTOBER)).toBeNull();
    expect(estimateCost(id, { inputTokens: 1_000, outputTokens: 10 }, OCTOBER)).toEqual({ usd: 0, unpriced: true });
  });
});

describe("a price that changes on a date", () => {
  test("is the one that held on the day of the call: 3.8 Flash doubles on 2027-01-01", () => {
    const usage = { inputTokens: M, outputTokens: M };
    expect(estimateCost("gemini-3.8-flash", usage, OCTOBER).usd).toBeCloseTo(0.75 + 3.75, 6);
    expect(estimateCost("gemini-3.8-flash", usage, NEXT_YEAR).usd).toBeCloseTo(1.5 + 7.5, 6);
    expect(estimateCost("gemini-4-argon", usage, Date.UTC(2026, 11, 1)).usd).toBeCloseTo(4 + 20, 6);
  });
});

describe("a long prompt", () => {
  test("past the vendor's threshold, prices the whole request at the long rates", () => {
    expect(estimateCost("gemini-2.5-pro", { inputTokens: 150_000, outputTokens: 0 }, OCTOBER).usd).toBeCloseTo(0.15 * 1.25, 6);
    expect(estimateCost("gemini-2.5-pro", { inputTokens: 250_000, outputTokens: 0 }, OCTOBER).usd).toBeCloseTo(0.25 * 2.5, 6);
    // Haiku 5.5 counts its cache reads in the prompt's length, as `inputTokens` does.
    expect(estimateCost("claude-haiku-5-5", { inputTokens: 101_000, outputTokens: 0, cachedInputTokens: 100_000 }, OCTOBER).usd).toBeCloseTo(
      (1_000 / M) * 0.5 + (100_000 / M) * 0.05,
      6,
    );
  });
});

describe("a cache read", () => {
  test("is the row's own cached price — a quarter on o3, a twentieth on Opus 5.5", () => {
    const allCached = { inputTokens: M, outputTokens: 0, cachedInputTokens: M };
    expect(estimateCost("o3", allCached, OCTOBER).usd).toBeCloseTo(0.5, 6);
    expect(estimateCost("claude-opus-5-5", allCached, OCTOBER).usd).toBeCloseTo(0.2, 6);
  });

  test("is charged as input where the page lists no cache price", () => {
    expect(estimateCost("gpt-5-pro", { inputTokens: M, outputTokens: 0, cachedInputTokens: M }, OCTOBER).usd).toBeCloseTo(15, 6);
  });
});
