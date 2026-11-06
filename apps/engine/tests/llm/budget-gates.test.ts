/**
 * Every caller of a model held to today's caps (`todaysVerdict`, `llm/budget.ts`). A turn and a job were; the calls no
 * one waits on were not — the compaction after a reply, `/compact`, a reflection pass, the memory pass's questions, an
 * embedding catch-up — so once a cap was reached they went on spending.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, LLMProvider, SessionKey } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import { resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import type { CompactionPlan } from "@/modules/llm/executor/types.ts";
import { compactAfterReply } from "@/modules/pipeline/session-lifecycle.ts";
import { embedder } from "@/boot/memory.ts";

/** A config whose token cap is 1,000, and a day that has spent `spent` tokens. */
function over(spent: number) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.llm.limits.maxDailyTokens = 1_000;
  const usage = {
    since: () => ({ usd: 0, unpricedRequests: 0, includedRequests: 0, requests: 3, inputTokens: spent, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }),
    record: () => {},
  };
  return { config, usage };
}

describe("today's verdict", () => {
  test("is the caps against the day's spend — and nothing to check is nothing refused", () => {
    expect(todaysVerdict(over(2_000).usage, over(2_000).config)).toMatchObject({ action: "refuse", message: expect.stringContaining("1,000 token cap") });
    expect(todaysVerdict(over(10).usage, over(10).config)).toEqual({ action: "allow" });
    expect(todaysVerdict(undefined, over(2_000).config)).toEqual({ action: "allow" });
  });
});

describe("past the cap", () => {
  test("the compaction after a reply is not made — the next turn compacts first, if it is let through", async () => {
    resetCompactionBreaker();
    const { config, usage } = over(2_000);
    config.llm.context.truncationStrategy = "summary";
    let calls = 0;
    const provider = { chat: async () => (calls++, { text: "Headline: x", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop", model: "m" }) } as unknown as LLMProvider;
    const stored: ChatMessage[] = Array.from({ length: 16 }, (_, n) => ({ role: n % 2 ? ("assistant" as const) : ("user" as const), content: "x".repeat(2_000), timestamp: n }));
    const plan: CompactionPlan = { threshold: 2_000, limit: 2_000, totalLimit: 16_000, source: "agent", summaryModel: "m", summarizerWindow: 1_000_000 };
    const key: SessionKey = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "c1" };
    await compactAfterReply({ config, usage, sessions: { save: () => {} } } as never, { key, sessionId: "s1", stored, plan, provider });
    expect(calls).toBe(0);
    // Under it, the same compaction is made.
    await compactAfterReply({ ...over(10), sessions: { save: () => {} } } as never, { key, sessionId: "s1", stored, plan: { ...plan }, provider }).catch(() => {});
    expect(calls).toBeGreaterThan(0);
  });

  test("memory is not embedded — searched by words alone — and under it, it is, metered as an embedding", async () => {
    let asked = 0;
    const recorded: string[] = [];
    const providers = { get: () => ({ kind: "openai", baseUrl: "x", chat: async () => ({}), stream: async function* () {}, embed: async () => (asked++, { vectors: [[1, 0]], inputTokens: 3 }) }) as unknown as LLMProvider };
    const semantic = { provider: "ollama", model: "bge-m3", dimensions: 2 };
    const capped = over(2_000);
    expect(await embedder({ providers, usage: capped.usage, config: capped.config })(semantic, ["halo"])).toBeNull();
    expect(asked).toBe(0);
    const open = over(10);
    const usage = { ...open.usage, record: (row: { purpose?: string | undefined }) => void recorded.push(row.purpose ?? "") };
    expect(await embedder({ providers, usage, config: open.config })(semantic, ["halo"])).toEqual([[1, 0]]);
    expect(recorded).toEqual(["embedding"]);
  });
});
