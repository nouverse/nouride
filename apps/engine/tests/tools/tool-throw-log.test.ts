/**
 * A tool's throw is logged at the level it deserves (`tools/audited.ts`, `logToolThrow`).
 *
 * The files tool refuses a path outside the workspace by throwing a `ToolError`, and the model is answered as for any
 * refusal. Both places that catch a throw logged it at `error` as "tool threw" — found in a live journal, where every
 * refused read sat among the daemon's faults and went to the error sinks with them.
 */

import { describe, expect, test } from "bun:test";
import { ToolError, addLogSink, type ChatResponse, type LLMProvider, type LogEntry, type Tool } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { audited } from "@/modules/tools/audited.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const entries: LogEntry[] = [];
addLogSink((entry) => entries.push(entry));
/** The lines logged about one tool name, which each test makes unique. */
const linesAbout = (tool: string) => entries.filter((entry) => entry.data?.tool === tool).map((entry) => `${entry.level} ${entry.message}`);

const refusing = (name: string): Tool => ({
  definition: { name, description: "", parameters: {} },
  requiresApproval: false,
  execute: async () => {
    throw new ToolError("files", "path escapes workspace: /etc/shadow", "outside the directories these tools open");
  },
});
const broken = (name: string): Tool => ({
  definition: { name, description: "", parameters: {} },
  requiresApproval: false,
  execute: async () => {
    throw new TypeError("cannot read properties of undefined");
  },
});

const noAudit = { record: () => {} } as unknown as AuditPort;
const ctx = { agentId: "a", senderId: "u", gatewayId: "telegram:main", chatId: "c", turnId: "turn_1" } as never;

describe("a tool's throw, through audited()", () => {
  test("a refusal the tool wrote is a warning, and the model still reads it as an error result", async () => {
    const result = await audited("read_refused", refusing("read_refused"), noAudit).execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(linesAbout("read_refused")).toEqual(["warn tool refused the call"]);
  });

  test("anything else thrown is still an error", async () => {
    await audited("read_broken", broken("read_broken"), noAudit).execute({}, ctx);
    expect(linesAbout("read_broken")).toEqual(["error tool threw"]);
  });
});

describe("a tool's throw, caught by the executor (a tool audited() did not wrap)", () => {
  async function turnCalling(tool: Tool): Promise<void> {
    let round = 0;
    const provider = {
      kind: "openai",
      async chat(): Promise<ChatResponse> {
        round += 1;
        return round === 1
          ? { text: "", toolCalls: [{ id: "call_1", name: tool.definition.name, arguments: {} }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
          : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
    } as unknown as LLMProvider;
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === tool.definition.name ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    });
    await executor.run({
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
    });
  }

  test("a refusal is a warning", async () => {
    await turnCalling(refusing("exec_refused"));
    expect(linesAbout("exec_refused")).toEqual(["warn tool refused the call"]);
  });

  test("a fault is an error", async () => {
    await turnCalling(broken("exec_broken"));
    expect(linesAbout("exec_broken")).toEqual(["error tool threw"]);
  });
});
