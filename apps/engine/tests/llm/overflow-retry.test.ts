/**
 * A gateway's window overflow, named inside its answer, is retried shorter (nouride-releases#14).
 *
 * The path end to end, through the real OpenAI client: a gateway that answers a request past its window with an `error`
 * in a 200 stream — Nougate's Codex route does since this fix — and the executor's `shrink`. The agent's model is one
 * whose window the table puts at 400k, behind a route that allows far less. Halving the *budget* there dropped nothing
 * (half of 400k is more than the whole conversation), so the turn failed on an overflow one shorter request clears;
 * half of what was sent does clear it.
 */

import { describe, expect, test } from "bun:test";
import { createProvider } from "@nouride/llm";
import type { ChatMessage, LLMProvider } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

/** What the route really takes, in characters of the messages sent: far below the table's 400k tokens. */
const ROUTE_WINDOW_CHARS = 30_000;

function gateway(): { provider: LLMProvider; sent: number[] } {
  const sent: number[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: unknown }[] };
    const chars = body.messages.reduce((sum, message) => sum + JSON.stringify(message.content ?? "").length, 0);
    sent.push(body.messages.length);
    const frames =
      chars > ROUTE_WINDOW_CHARS
        ? ['data: {"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_error","code":"context_length_exceeded"}}\n\n']
        : ['data: {"choices":[{"delta":{"content":"answered"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'];
    return new Response([...frames, "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { provider: createProvider({ kind: "openai", baseUrl: "https://gw.example/v1", apiKey: "test-key", http: { fetchImpl, sleep: async () => {} } }), sent };
}

/** Eight earlier exchanges of about 5k characters each: 40k in all, past the route's window and nowhere near the table's. */
const history: ChatMessage[] = Array.from({ length: 8 }, (_, i) => [
  { role: "user" as const, content: `question ${i}: ${"q".repeat(2_500)}`, timestamp: i * 2 },
  { role: "assistant" as const, content: `answer ${i}: ${"a".repeat(2_500)}`, timestamp: i * 2 + 1 },
]).flat();

describe("a window overflow named inside the gateway's answer", () => {
  test("is retried once with the conversation's older half left out, and that answer is the reply", async () => {
    const { provider, sent } = gateway();
    const toolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => undefined, blockedPatterns: [] } as unknown as AgentToolset;
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    });
    const agent = fakeAgent();
    agent.config.llm = { ...agent.config.llm, provider: "nougate", model: "codex:gpt-5.6-luna" };

    const result = await executor.run({
      agent, provider, toolset, history,
      userMessage: { role: "user", content: "lanjutkan", timestamp: 100 },
      gateway: "web", gatewayId: "web:dashboard", chatId: "chat-1", chatType: "dm", sessionId: "s1", senderId: "u1",
    });

    expect(result.text).toBe("answered");
    expect(sent).toHaveLength(2);
    // The retry carried fewer messages — and still the person's last one.
    expect(sent[1]!).toBeLessThan(sent[0]!);
  });
});
