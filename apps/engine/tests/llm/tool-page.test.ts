/**
 * A call that made or changed something with a dashboard page says which (`ToolResult.page`), and the executor
 * writes it on the call's `tool_done` (`page`, stream 1.9). A chat in the dashboard reads it there: it opens what the
 * agent made and refreshes the page under it, without reading the tool's words for an address.
 */

import { expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { ActivityKind } from "@/commons/activity.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

test("the page a call says is on its `tool_done`; a call that failed, or made nothing with a page, has none", async () => {
  const tools: Record<string, Tool> = {
    propose: { definition: { name: "propose", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: "Proposed as cron_1.", isError: false, page: "/automations/cron_1" }) },
    refused: { definition: { name: "refused", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: "Not proposed.", isError: true, page: "/automations/cron_2" }) },
    read: { definition: { name: "read", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: "a file", isError: false }) },
  };
  let round = 0;
  const provider = {
    kind: "openai",
    async chat(): Promise<ChatResponse> {
      round += 1;
      const name = ["propose", "refused", "read"][round - 1];
      return name
        ? { text: "", toolCalls: [{ id: `call_${round}`, name, arguments: {} }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
        : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
    },
  } as unknown as LLMProvider;
  const toolset = {
    definitions: Object.values(tools).map((tool) => tool.definition),
    get: (name: string) => tools[name],
    requiresApproval: () => false,
    parallelSafe: () => true,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const done: Record<string, unknown>[] = [];
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 8, maxTokensPerTurn: 1024 },
      context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity: (kind: ActivityKind, _text, detail) => void (kind === "tool_done" && detail ? done.push(detail) : undefined),
  });
  await executor.run({
    agent: fakeAgent(),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "make one", timestamp: 1 },
    gateway: "web",
    gatewayId: "web:dashboard",
    chatId: "web-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
  });
  expect(done.map((detail) => [detail.name, detail.page])).toEqual([
    ["propose", "/automations/cron_1"],
    ["refused", undefined],
    ["read", undefined],
  ]);
});
