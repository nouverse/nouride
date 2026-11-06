/**
 * A turn's wrap-up is logged by why it ran (`executor/provider-caller.ts`, `wrapUp`).
 *
 * Starting a background job ends the turn on purpose — the tool asks for it — and the wrap-up that writes its reply
 * was logged at `warn` as "wrapping up a turn that would otherwise say nothing", the commonest warning in a live
 * journal. A rescue — the iteration cap, a deadline, an empty reply — is still a warning.
 */

import { describe, expect, test } from "bun:test";
import { addLogSink, type ChatResponse, type LLMProvider, type LogEntry, type Tool } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const entries: LogEntry[] = [];
addLogSink((entry) => entries.push(entry));
const linesOf = (turnId: string) =>
  entries.filter((entry) => entry.turn_id === turnId && /wrap|finishing/.test(entry.message)).map((entry) => `${entry.level} ${entry.message} (${String(entry.data?.reason)})`);

/** A turn whose model calls `tool` every round until told it cannot, then answers. */
async function turn(turnId: string, tool: Tool, maxToolIterations: number): Promise<void> {
  // A different call each round: the same one answered the same ends the turn on its own (`SameAnswers`).
  let round = 0;
  const provider = {
    kind: "openai",
    async chat(params: { tools?: unknown[] }): Promise<ChatResponse> {
      // Offered no tools — the wrap-up withholds them — it answers.
      if (!params.tools || params.tools.length === 0) {
        return { text: "here is where things stand", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      }
      return { text: "", toolCalls: [{ id: `c${entries.length}`, name: tool.definition.name, arguments: { n: ++round } }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
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
      limits: { maxToolIterations, maxTokensPerTurn: 1024 },
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
    turnId,
  });
}

describe("the wrap-up's log line", () => {
  test("a turn a background job ended is info: it went as designed", async () => {
    const starts: Tool = {
      definition: { name: "exec", description: "", parameters: {} },
      requiresApproval: false,
      execute: async () => ({ content: "started job_1", isError: false, metadata: { control: { finishTurn: "wrap_up", note: "background_started" } } }),
    };
    await turn("turn_asked", starts, 8);
    expect(linesOf("turn_asked")).toEqual(["info finishing a turn a tool ended (background_started)"]);
  });

  test("a turn that ran into the iteration cap is still a warning", async () => {
    const loops: Tool = {
      definition: { name: "read", description: "", parameters: {} },
      requiresApproval: false,
      execute: async () => ({ content: "more", isError: false }),
    };
    await turn("turn_capped", loops, 2);
    const lines = linesOf("turn_capped");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("warn wrapping up a turn that would otherwise say nothing");
  });
});
