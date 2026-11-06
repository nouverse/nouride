/**
 * A tool call's step text is redacted as its audit row is.
 *
 * `describeToolCall` keeps the start of a command, and a token an agent wrote inline went into the `tool` row as
 * written — kept for `session_days`, served to every dashboard viewer — while the same call's `audit` row, through
 * `redact`, said `[redacted:…]`. Through the real executor, as the step log and the stream receive it.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { ActivityKind } from "@/commons/activity.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

describe("the step text of a tool call", () => {
  test("keeps no credential the command carried — one call and two at once alike", async () => {
    let round = 0;
    const provider = {
      kind: "openai",
      async chat(): Promise<ChatResponse> {
        round += 1;
        const curl = (id: string) => ({ id, name: "exec", arguments: { command: ["curl", "-H", `Authorization: token ${TOKEN}`, "https://api.github.com/user"] } });
        return round === 1
          ? { text: "", toolCalls: [curl("c1")], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
          : round === 2
            ? { text: "", toolCalls: [curl("c2"), curl("c3")], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
            : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
    } as unknown as LLMProvider;
    const exec: Tool = { definition: { name: "exec", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: "ok", isError: false }) };
    const toolset = {
      definitions: [exec.definition],
      get: (name: string) => (name === "exec" ? exec : undefined),
      requiresApproval: () => false,
      parallelSafe: () => true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const said: { kind: ActivityKind; text: string }[] = [];
    const batches: string[][] = [];
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 8, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onActivity: (kind, text) => void said.push({ kind, text }),
      onBatch: (lines) => void batches.push(lines),
    });
    await executor.run({
      agent: fakeAgent(),
      provider,
      toolset,
      history: [],
      userMessage: { role: "user", content: "check my github user", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    const tools = said.filter((step) => step.kind === "tool").map((step) => step.text);
    expect(tools).toHaveLength(3);
    for (const text of [...tools, ...batches.flat()]) {
      expect(text).not.toContain(TOKEN);
      expect(text).toContain("[redacted:");
    }
    expect(batches).toHaveLength(1);
  });
});
