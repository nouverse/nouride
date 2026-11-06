/**
 * Compaction says it is happening, as a `compact` step, while it happens — and what it did, in the step's data.
 *
 * It used to be one `thinking` line after the summary came back. `thinking` never reaches a chat
 * bubble and is never kept in the turn record, so on Telegram a turn spent its compaction looking
 * hung, and afterwards nothing showed it had compacted at all.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatResponse, LLMProvider } from "@nouride/shared";
import type { ActivityKind } from "@/commons/activity.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const emptyToolset = {
  definitions: [],
  get: () => undefined,
  requiresApproval: () => false,
  parallelSafe: () => false,
  gate: () => ({ action: "run", via: "allowlist" }),
  blockedPatterns: [],
} as unknown as AgentToolset;

/** A long conversation: many turns, each big enough that together they pass any small threshold. */
const longHistory = (): ChatMessage[] =>
  Array.from({ length: 12 }, (_, i) => [
    { role: "user" as const, content: `question ${i} ${"x".repeat(2_000)}`, timestamp: i },
    { role: "assistant" as const, content: `answer ${i} ${"y".repeat(2_000)}`, timestamp: i },
  ]).flat();

function run(onActivity: (kind: ActivityKind, text: string, detail?: Record<string, unknown>) => void, summary: string | Error) {
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(params: { temperature?: number }): Promise<ChatResponse> {
      // The summary call is the deterministic one; everything else is the turn.
      if (params.temperature === 0) {
        if (summary instanceof Error) throw summary;
        return { text: summary, toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } as ChatResponse;
      }
      return { text: "answered", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } as ChatResponse;
    },
  } as unknown as LLMProvider;

  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
      context: {
        maxContextRatio: 0.8,
        truncationStrategy: "summary",
        preserveRecentTurns: 2,
        summaryModel: undefined,
        compactAtRatio: 0.05,
        compactAtTokens: 1_000,
        preserveRecentToolResults: 3,
      },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity,
  });

  return executor.run({
    agent: fakeAgent(),
    provider,
    toolset: emptyToolset,
    history: longHistory(),
    userMessage: { role: "user", content: "and now?", timestamp: 99 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
  });
}

describe("compaction steps", () => {
  test("one before the summary and one after it, as compact steps saying what they did", async () => {
    const steps: { text: string; detail?: Record<string, unknown> }[] = [];
    await run((kind, text, detail) => {
      if (kind === "compact") steps.push({ text, ...(detail ? { detail } : {}) });
    }, "- what was decided");

    const compacting = steps.findIndex((step) => step.text.startsWith("compacting the conversation"));
    const compacted = steps.findIndex((step) => step.text.startsWith("compacted:"));
    expect(compacting).toBeGreaterThanOrEqual(0);
    expect(compacted).toBeGreaterThan(compacting);
    expect(steps[compacting]!.text).toMatch(/summarizing \d+ earlier turn\(s\), ~[\d.]+k? tokens/);
    expect(steps[compacting]!.detail).toMatchObject({ phase: "start", turns: expect.any(Number), tokens: expect.any(Number) });
    expect(steps[compacted]!.detail).toMatchObject({ phase: "done", turns: expect.any(Number), pruned: expect.any(Number), tokens: expect.any(Number) });
  });

  test("a summary that fails says it fell back", async () => {
    const steps: { text: string; detail?: Record<string, unknown> }[] = [];
    await run((kind, text, detail) => {
      if (kind === "compact") steps.push({ text, ...(detail ? { detail } : {}) });
    }, new Error("summary model down"));

    expect(steps).toContainEqual({ text: "compaction failed: dropping the oldest turns instead", detail: { phase: "failed" } });
  });
});
