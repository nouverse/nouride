/**
 * Gemini's thought signature, through a whole turn (`ToolCall.extraContent`).
 *
 * Gemini 3 behind its OpenAI-compatible endpoint sends a signature beside the first call of each step and refuses, with
 * a 400, the next request of the turn when that call comes back without it. A hosted pod's agent on Gemini failed every
 * turn that used a tool that way: it could introduce itself, and broke at the first tool. Here the real OpenAI-format
 * client talks to an endpoint that answers as Gemini does, refusal included, and the turn runs through the executor.
 */

import { describe, expect, test } from "bun:test";
import type { Tool } from "@nouride/shared";
import { createProvider } from "@nouride/llm";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const SIGNATURE = { google: { thought_signature: "c2lnLXN0ZXAtMQ==" } };

type WireCall = { id: string; function: { name: string }; extra_content?: unknown };
type WireMessage = { role: string; tool_calls?: WireCall[] };

/** One answer as a stream's events, the way a request with `stream: true` is answered. */
function streamed(chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * Answers as Gemini 3 does: two parallel calls, the first signed; then the answer, or a 400 when the signature is gone.
 * Asked with `stream: true` it answers in events, the signature on the first fragment of its call.
 */
function geminiLike() {
  const bodies: { messages: WireMessage[]; stream?: boolean }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const assistant = body.messages.find((message: WireMessage) => message.role === "assistant" && message.tool_calls?.length);
    if (!assistant && body.stream) {
      return streamed([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "look", arguments: "" }, extra_content: SIGNATURE }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"what":"a"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "look", arguments: '{"what":"b"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]);
    }
    if (!assistant) {
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "look", arguments: '{"what":"a"}' }, extra_content: SIGNATURE },
                { id: "c2", type: "function", function: { name: "look", arguments: '{"what":"b"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    const first = assistant.tool_calls[0];
    if (JSON.stringify(first.extra_content) !== JSON.stringify(SIGNATURE)) {
      return Response.json({ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts.", status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    if (body.stream) {
      return streamed([{ choices: [{ delta: { content: "a and b looked at" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } }]);
    }
    return Response.json({ choices: [{ message: { content: "a and b looked at" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

async function runTurn(fetchImpl: typeof fetch, streaming = false) {
  const provider = createProvider({ kind: "openai", baseUrl: "https://gemini.example/v1beta/openai", apiKey: "k", http: { fetchImpl, sleep: async () => {} } });
  const look: Tool = { definition: { name: "look", description: "", parameters: {} }, requiresApproval: false, execute: async () => ({ content: "seen", isError: false }) };
  const toolset = {
    definitions: [look.definition],
    get: (name: string) => (name === "look" ? look : undefined),
    requiresApproval: () => false,
    parallelSafe: () => true,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: streaming, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 5, maxTokensPerTurn: 1024 },
      context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });
  return await executor.run({
    agent: fakeAgent(),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "look at a and b", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
    turnId: "turn_signature",
  });
}

describe("Gemini's thought signature through a turn", () => {
  test("the signed call goes back signed, the unsigned one goes back bare, and the turn answers", async () => {
    const gemini = geminiLike();
    const result = await runTurn(gemini.fetchImpl);

    expect(result.text).toBe("a and b looked at");
    expect(gemini.bodies).toHaveLength(2);
    const sent = gemini.bodies[1]!.messages.find((message) => message.role === "assistant")!.tool_calls!;
    expect(sent.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(sent[0]!.extra_content).toEqual(SIGNATURE);
    expect(sent[1]).not.toHaveProperty("extra_content");
    // Kept on the turn's own record too, so a journal replay sends it back as well.
    const kept = result.turnMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    expect(kept?.toolCalls?.[0]?.extraContent).toEqual(SIGNATURE);
  });

  // The way a daemon asks unless it is told otherwise: `llm.streaming.enabled` is on by default, and a call gathered
  // from a stream's fragments is another path through the client and the executor than a whole answer's.
  test("streamed, as a daemon asks by default: the signature on a call's first fragment goes back with it", async () => {
    const gemini = geminiLike();
    const result = await runTurn(gemini.fetchImpl, true);

    expect(gemini.bodies.map((body) => body.stream)).toEqual([true, true]);
    expect(result.text).toBe("a and b looked at");
    const sent = gemini.bodies[1]!.messages.find((message) => message.role === "assistant")!.tool_calls!;
    expect(sent.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(sent[0]!.extra_content).toEqual(SIGNATURE);
    expect(sent[1]).not.toHaveProperty("extra_content");
  });
});
