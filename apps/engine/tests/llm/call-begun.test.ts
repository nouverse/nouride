/**
 * The model began a tool call (`ExecutorDeps.onCallBegun`): told once a request, as a call's arguments start to
 * arrive, so whoever watches the model write knows it is no longer the reply.
 *
 * A model that said a line and then wrote a long command (a script to run) had a chat's bubble say "writing a reply"
 * for half a minute, and then run another step: the words before a call were taken for the answer.
 */

import { describe, expect, test } from "bun:test";
import type { ChatParams, LLMProvider, StreamChunk, Tool } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const look: Tool = {
  requiresApproval: false,
  definition: { name: "look", description: "looks", parameters: { type: "object", properties: {} } },
  async execute() {
    return { content: "seen", isError: false };
  },
};

const toolset = (): AgentToolset => ({
  definitions: [look.definition],
  get: (name) => (name === "look" ? look : undefined),
  requiresApproval: () => false,
  parallelSafe: () => false,
  gate: () => ({ action: "run", via: "allowlist" }),
  blockedPatterns: [],
});

/** A model that answers each request with the chunks scripted for it, in order. */
function scripted(requests: StreamChunk[][]): LLMProvider {
  let at = 0;
  return {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat() {
      throw new Error("this test streams");
    },
    async *stream(_params: ChatParams) {
      for (const chunk of requests[Math.min(at++, requests.length - 1)]!) yield chunk;
    },
  } as unknown as LLMProvider;
}

async function run(requests: StreamChunk[][]) {
  const seen: string[] = [];
  const agent = fakeAgent();
  agent.config.llm = { provider: "test", model: "gpt-4", maxTokens: 128, temperature: 0.7 };
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: true, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 4, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onText: (delta) => void seen.push(`text:${delta}`),
    onCallBegun: () => void seen.push("call"),
  });
  const result = await executor.run({
    agent,
    provider: scripted(requests),
    toolset: toolset(),
    history: [],
    userMessage: { role: "user", content: "have a look", timestamp: Date.now() },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "session-1",
    senderId: "user-1",
  });
  return { seen, result };
}

const usage = { inputTokens: 1, outputTokens: 1 };

describe("the model began a tool call", () => {
  test("is said once in a request, when the call's arguments start to arrive, after the words before it", async () => {
    const { seen, result } = await run([
      [
        { type: "text", delta: "Let me look. " },
        { type: "progress", bytes: 40 },
        { type: "progress", bytes: 900 },
        { type: "tool_call", call: { id: "c1", name: "look", arguments: {} } },
        { type: "usage", usage },
        { type: "done", stopReason: "tool_calls" },
      ],
      [{ type: "text", delta: "All fine." }, { type: "usage", usage }, { type: "done", stopReason: "stop" }],
    ]);
    // Once for the first request, however many pieces its arguments came in; never for the reply.
    expect(seen).toEqual(["text:Let me look. ", "call", "text:All fine."]);
    expect(result.text).toContain("All fine.");
  });

  test("and when a call arrives whole, with nothing said of its arguments first", async () => {
    const { seen } = await run([
      [{ type: "tool_call", call: { id: "c1", name: "look", arguments: {} } }, { type: "usage", usage }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text", delta: "Done." }, { type: "usage", usage }, { type: "done", stopReason: "stop" }],
    ]);
    expect(seen).toEqual(["call", "text:Done."]);
  });
});
