/**
 * Compacting right after a reply, and measuring against what the
 * provider actually billed.
 *
 * Found on the box: a pasted log of timestamps and ids tokenized at 2.3x the character estimate, so an
 * agent limited to 16k compacted at 27k. The turn measures what its provider counts per estimated token
 * and hands back its compaction plan at that scale (`llm/context-scale.ts`); this holds the estimate
 * against it.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatParams, ChatResponse, LLMProvider, SessionKey } from "@nouride/shared";
import { estimateMessagesTokens, estimateTokens, flattenSystem } from "@nouride/llm";
import { compactAfterReply } from "@/modules/pipeline/session-lifecycle.ts";
import { resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { CompactionPlan } from "@/modules/llm/executor/types.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const key: SessionKey = { agentId: "e2e", gatewayId: "web:dashboard", chatId: "cli-1" };

const history = (turns: number): ChatMessage[] =>
  Array.from({ length: turns }, (_, i) => [
    { role: "user" as const, content: `question ${i} ${"x".repeat(2_000)}`, timestamp: i * 10 },
    { role: "assistant" as const, content: `answer ${i}`, timestamp: i * 10 + 1 },
  ]).flat();

function harness() {
  const saved: ChatMessage[][] = [];
  const calls: ChatParams[] = [];
  const provider = {
    async chat(params: ChatParams) {
      calls.push(params);
      return { text: "Headline: x\nnotes", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop", model: "m" };
    },
  } as unknown as LLMProvider;
  const deps = {
    config: { llm: { context: { truncationStrategy: "summary" } }, daemon: { timezone: "UTC" } },
    sessions: { save: (_key: SessionKey, messages: ChatMessage[]) => void saved.push(messages) },
  } as never;
  return { saved, calls, provider, deps };
}

// ~4k estimated tokens of history against a 6k threshold: under it by the estimate alone.
const plan: CompactionPlan = { threshold: 6_000, limit: 6_000, totalLimit: 16_000, source: "agent", summaryModel: "m", summarizerWindow: 1_000_000 };

const emptyToolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };

/**
 * One turn over `history(8)`, answered by a provider whose tokenizer counts `factor` tokens for every one
 * the estimator counts — and the compaction plan the turn hands back.
 *
 * A 40k window at a 0.3 compaction ratio: ~8k of history by the estimate, so the pass before the turn
 * leaves these eight turns alone, and ~3k once the provider has counted 2.3 tokens for each of ours.
 */
async function planAfter(factor: number): Promise<{ stored: ChatMessage[]; plan: CompactionPlan }> {
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(params: ChatParams): Promise<ChatResponse> {
      const estimate = estimateTokens(flattenSystem(params.system)) + estimateMessagesTokens(params.messages);
      return { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: Math.round(estimate * factor), outputTokens: 2 }, model: "gpt-4o" };
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  agent.config.llm = { provider: "test", model: "gpt-4o", maxTokens: 1_000, temperature: 0, contextWindow: 40_000 };
  const result = await new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.3, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  }).run({
    agent,
    provider,
    toolset: emptyToolset,
    history: history(8),
    userMessage: { role: "user", content: "and the log?", timestamp: 99 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s-after",
    senderId: "u1",
  });
  return { stored: result.messages, plan: result.compaction };
}

describe("compactAfterReply", () => {
  test("under the threshold, nothing happens", async () => {
    resetCompactionBreaker();
    const h = harness();
    await compactAfterReply(h.deps, { key, sessionId: "s1", stored: history(8), plan, provider: h.provider });
    expect(h.calls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  test("a context the provider billed as larger than estimated is compacted on the real number", async () => {
    resetCompactionBreaker();
    // Billed at ~2.3x the estimate, the way a dense log tokenizes: the same history the estimate alone keeps.
    const dense = await planAfter(2.3);
    const raw = await planAfter(0.9);
    expect(dense.plan.threshold).toBeLessThan(raw.plan.threshold);

    const kept = harness();
    await compactAfterReply(kept.deps, { key, sessionId: "s2", stored: raw.stored, plan: raw.plan, provider: kept.provider });
    expect(kept.calls).toHaveLength(0);

    const h = harness();
    await compactAfterReply(h.deps, { key, sessionId: "s2", stored: dense.stored, plan: dense.plan, provider: h.provider });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.saved).toHaveLength(1);
  });

  test("says so on the turn that ended — the compaction that usually runs is this one, not the one before a turn", async () => {
    resetCompactionBreaker();
    const h = harness();
    const said: { text: string; detail: Record<string, unknown> }[] = [];
    const dense = await planAfter(2.3);
    await compactAfterReply(h.deps, { key, sessionId: "s3", stored: dense.stored, plan: dense.plan, provider: h.provider, say: (text, detail) => void said.push({ text, detail }) });
    expect(said.map((step) => step.detail.phase)).toEqual(["start", "done"]);
    expect(said[0]?.text).toStartWith("compacting the conversation");
    expect(said[1]?.detail).toMatchObject({ turns: expect.any(Number), tokens: expect.any(Number) });
  });
});
