/**
 * `PromptResponse.usage` (ACP, unstable): read where its counts are numbers, null where the agent sent none — so a
 * caller can tell "spent nothing" from "said nothing".
 */

import { describe, expect, test } from "bun:test";
import { promptUsageOf } from "../src/protocol.ts";

describe("a prompt's usage", () => {
  test("its counts, a missing total made from the two", () => {
    expect(promptUsageOf({ totalTokens: 30, inputTokens: 20, outputTokens: 10 })).toEqual({ totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: null, cachedWriteTokens: null });
    expect(promptUsageOf({ inputTokens: 20, outputTokens: 10 })).toEqual({ totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: null, cachedWriteTokens: null });
  });

  test("the cache read and written, as claude-agent-acp and codex-acp send them beside the input", () => {
    expect(promptUsageOf({ totalTokens: 1_045, inputTokens: 20, outputTokens: 25, cachedReadTokens: 900, cachedWriteTokens: 100 })).toEqual({
      totalTokens: 1_045,
      inputTokens: 20,
      outputTokens: 25,
      cachedReadTokens: 900,
      cachedWriteTokens: 100,
    });
    // A cache count that is no count is not one: said as nothing, not zero.
    expect(promptUsageOf({ totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: "lots", cachedWriteTokens: null })?.cachedReadTokens).toBeNull();
  });

  test("none sent, or nothing that is a count: null, not zero", () => {
    expect(promptUsageOf(undefined)).toBeNull();
    expect(promptUsageOf(null)).toBeNull();
    expect(promptUsageOf({})).toBeNull();
    expect(promptUsageOf({ totalTokens: "many", inputTokens: -1 })).toBeNull();
  });
});
