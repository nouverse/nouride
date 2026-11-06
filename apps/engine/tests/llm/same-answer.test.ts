/**
 * The same call answered the same, again and again, inside one turn (`executor/nudges.ts`, `SameAnswers`).
 *
 * A mission on the live box ran `nouride approvals` 40 times in one turn, waiting for an answer that comes as a message
 * of its own. At the third same answer the result says it will not change; at the fifth the turn ends. A call whose
 * answer changes — a service coming up — is never counted.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

/** A turn whose model calls `poll` every round it may, then answers; what each request carried is kept. */
async function turn(answer: (n: number) => string) {
  const requests: ChatMessage[][] = [];
  let n = 0;
  const provider = {
    kind: "openai",
    async chat(params: { tools?: unknown[]; toolChoice?: string; messages: ChatMessage[] }): Promise<ChatResponse> {
      requests.push(params.messages);
      // The wrap-up offers the tools with `none` (kept for the prompt cache) — or none at all.
      if (!params.tools || params.tools.length === 0 || params.toolChoice === "none") return { text: "still waiting on the approval", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      return { text: "", toolCalls: [{ id: `c${requests.length}`, name: "poll", arguments: { what: "approvals" } }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
    },
  } as unknown as LLMProvider;
  const poll: Tool = { definition: { name: "poll", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: answer(++n), isError: false }) };
  const toolset = {
    definitions: [poll.definition],
    get: (name: string) => (name === "poll" ? poll : undefined),
    requiresApproval: () => false,
    parallelSafe: () => true,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 10, maxTokensPerTurn: 1024 },
      context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });
  const result = await executor.run({
    agent: fakeAgent(),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "go", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
    turnId: "turn_same",
  });
  const results = result.turnMessages.filter((m) => m.role === "tool").map((m) => String(m.content));
  return { result, requests, results };
}

describe("the same call answered the same", () => {
  test("is told at the third that it will not change, and ends the turn at the fifth", async () => {
    const { result, requests, results } = await turn(() => "1 waiting: apr_1 nouride agent sleep nox");
    expect(results).toHaveLength(5);
    expect(results[1]).not.toContain("[harness]");
    expect(results[2]).toContain("It will not change by asking again");
    expect(results[2]).toContain("come to you as a message of their own");
    // Five rounds, then the wrap-up: no sixth call.
    expect(requests).toHaveLength(6);
    expect(result.wrappedUp).toBe("same_answer");
    expect(result.text).toBe("still waiting on the approval");
  });

  test("a call whose answer changes is never counted", async () => {
    const { result, results } = await turn((n) => `${n * 5}s in: not up yet`);
    expect(results).toHaveLength(10);
    expect(results.some((text) => text.includes("[harness] The same call"))).toBe(false);
    expect(result.wrappedUp).toBe("iteration cap");
  });
});
