/**
 * What a coding CLI says a prompt spent, as `llm_usage` records it (`cliUsage`).
 */

import { describe, expect, test } from "bun:test";
import type { PromptUsage } from "@nouride/acp";
import { cliUsage } from "@/modules/external-agents/usage.ts";

const said = (over: Partial<PromptUsage>): PromptUsage => ({ totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: null, cachedWriteTokens: null, ...over });

describe("a CLI's prompt, recorded", () => {
  test("the cache read and written are counted inside the input, as a provider's are", () => {
    const usage = cliUsage(said({ totalTokens: 1234, inputTokens: 100, outputTokens: 234, cachedReadTokens: 800, cachedWriteTokens: 100 }));
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 234, cachedInputTokens: 800, cacheCreationInputTokens: 100, cli: true });
  });

  test("one that says only its total is not recorded as nothing — the total, as input, marked an estimate", () => {
    // A2 (Nox's review of msn_3d28e0): a CLI reporting only `totalTokens` was recorded as 0 in and 0 out.
    const usage = cliUsage(said({ totalTokens: 5000 }));
    expect(usage).toEqual({ inputTokens: 5000, outputTokens: 0, estimated: true, cli: true });
  });

  test("a prompt that spent nothing is still nothing, and not an estimate", () => {
    expect(cliUsage(said({}))).toEqual({ inputTokens: 0, outputTokens: 0, cli: true });
  });
});
