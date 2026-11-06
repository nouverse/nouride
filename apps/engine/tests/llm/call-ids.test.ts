/**
 * Every tool call of a turn has an id of its own (`executor/call-ids.ts`).
 *
 * An OpenAI-compatible gateway that streams calls without ids gets `call_0`, `call_1`… from the client — the same
 * names on every round trip — so a follower of the event stream, which pairs a `tool` with its `tool_done` and its
 * `audit` row by `callId`, paired a second call with the first one's result.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatResponse, LLMProvider, Tool, ToolCall } from "@nouride/shared";
import type { ActivityKind } from "@/commons/activity.ts";
import { withUniqueIds } from "@/modules/llm/executor/call-ids.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const call = (id: string): ToolCall => ({ id, name: "read", arguments: {} });

describe("an id of its own", () => {
  test("a fresh id is kept; a missing or repeated one is replaced, across rounds", () => {
    const seen = new Set<string>();
    expect(withUniqueIds([call("toolu_a"), call(""), call("call_0")], seen, 1).map((c) => c.id)).toEqual(["toolu_a", "call_1_1", "call_0"]);
    expect(withUniqueIds([call("call_0"), call("toolu_a")], seen, 2).map((c) => c.id)).toEqual(["call_2_0", "call_2_1"]);
  });

  test("a made-up id never takes one already in use", () => {
    const seen = new Set(["call_3_0"]);
    expect(withUniqueIds([call("")], seen, 3)[0]!.id).toBe("call_3_0_1");
  });

  test("in a turn: two rounds of `call_0` are two calls, each result paired with its own", async () => {
    let round = 0;
    const provider = {
      kind: "openai",
      async chat(): Promise<ChatResponse> {
        round += 1;
        return round <= 2
          ? { text: "", toolCalls: [{ id: "call_0", name: "read", arguments: { path: `${round}.md` } }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
          : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
    } as unknown as LLMProvider;
    const read: Tool = { definition: { name: "read", description: "", parameters: {} }, requiresApproval: false, execute: async (args) => ({ content: `read ${String(args.path)}`, isError: false }) };
    const toolset = {
      definitions: [read.definition],
      get: (name: string) => (name === "read" ? read : undefined),
      requiresApproval: () => false,
      parallelSafe: () => true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const steps: { kind: ActivityKind; detail?: Record<string, unknown> }[] = [];
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 8, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onActivity: (kind, _text, detail) => void steps.push({ kind, ...(detail ? { detail } : {}) }),
    });
    const result = await executor.run({
      agent: fakeAgent(),
      provider,
      toolset,
      history: [],
      userMessage: { role: "user", content: "read both", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    const asked = result.messages.flatMap((message: ChatMessage) => message.toolCalls ?? []).map((c) => c.id);
    const answered = result.messages.filter((message: ChatMessage) => message.role === "tool").map((message) => message.toolCallId);
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(2);
    expect(answered).toEqual(asked);
    const pairs = steps.filter((step) => step.kind === "tool" || step.kind === "tool_done").map((step) => [step.kind, step.detail?.callId]);
    expect(pairs).toEqual([["tool", asked[0]], ["tool_done", asked[0]], ["tool", asked[1]], ["tool_done", asked[1]]]);
  });
});
