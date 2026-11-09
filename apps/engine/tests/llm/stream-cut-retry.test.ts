/**
 * A stream cut before any of its reply is asked again once, on the same model, before any fallback.
 *
 * The request is retried inside the client, but a stream that broke off after the headers was not: with a fallback
 * listed the next pair answered, and without one the turn ended and was taken up again minutes later, for one dropped
 * socket. Nothing had been shown and nothing had run — tool calls are acted on once the stream finishes — so asking
 * again is safe.
 */

import { describe, expect, test } from "bun:test";
import { createProvider } from "@nouride/llm";
import type { LLMProvider, Tool } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const frame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const ROLE = frame({ choices: [{ delta: { role: "assistant" } }] });
const answer = (text: string): string[] => [frame({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }), "data: [DONE]\n\n"];

/**
 * How a stream ends when it is cut: its socket closed under it, or closed cleanly with no finish said.
 * Each request is answered by the next script in `replies`, the last one again once they run out.
 */
type Reply = { frames: string[]; then: "socket" | "close" | "finish" };

function endpoint(replies: Reply[], asked: string[], label: string): LLMProvider {
  return createProvider({
    kind: "openai",
    baseUrl: "https://cut.test/v1",
    apiKey: "k",
    http: {
      maxAttempts: 1,
      sleep: async () => {},
      fetchImpl: (async () => {
        const reply = replies[Math.min(asked.filter((who) => who === label).length, replies.length - 1)]!;
        asked.push(label);
        // A turn asking for ever never yields to a timer, so it would hang the file rather than fail it.
        if (asked.length > 10) throw new Error(`asked ${asked.length} times — retrying a cut in a loop`);
        const encoder = new TextEncoder();
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent < reply.frames.length) return controller.enqueue(encoder.encode(reply.frames[sent++]!));
            if (reply.then === "socket") controller.error(new TypeError("The socket connection was closed unexpectedly."));
            else controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    },
  });
}

function run(provider: LLMProvider, options: { fallback?: LLMProvider; tool?: Tool } = {}) {
  const activity: string[] = [];
  const written: string[] = [];
  const tool = options.tool;
  const toolset = {
    definitions: tool ? [tool.definition] : [],
    get: (name: string) => (tool && name === tool.definition.name ? tool : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const agent = fakeAgent({ config: { ...fakeAgent().config, llm: { provider: "nougate", model: "primary", maxTokens: 1024, temperature: 0 } } });
  const result = new TurnExecutor({
    llm: {
      streaming: { enabled: true, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity: (kind, text) => void activity.push(`${kind}: ${text}`),
    onText: (delta) => void written.push(delta),
  }).run({
    agent,
    provider,
    ...(options.fallback ? { fallbacks: [{ profile: "openrouter", model: "claude", provider: options.fallback }] } : {}),
    toolset,
    history: [],
    userMessage: { role: "user", content: "what time is it?", timestamp: 1 },
    gateway: "telegram", gatewayId: "telegram:main", chatId: "chat-1", chatType: "dm", sessionId: "s1", senderId: "u1",
  });
  return { result, activity, written };
}

describe("a stream cut before its reply began", () => {
  test("is asked again on the same model, and that answer is the reply — no fallback needed", async () => {
    const asked: string[] = [];
    const { result, activity, written } = run(endpoint([{ frames: [ROLE], then: "socket" }, { frames: answer("noon"), then: "finish" }], asked, "primary"));

    expect((await result).text).toBe("noon");
    expect(asked).toEqual(["primary", "primary"]);
    expect(written).toEqual(["noon"]);
    expect(activity).toContain("retry: primary's stream was cut before its reply began: asking it again");
  });

  test("a stream that closed with no finish, part-way through a tool call's arguments, is asked again and the call runs once", async () => {
    const asked: string[] = [];
    let ran = 0;
    const clock: Tool = {
      requiresApproval: false,
      definition: { name: "clock", description: "the time", parameters: { type: "object", properties: { zone: { type: "string" } } } },
      execute: async () => ((ran += 1), { content: "noon", isError: false }),
    };
    const call = (args: string) => frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "clock", arguments: args } }] } }] });
    const { result } = run(
      endpoint(
        [
          { frames: [ROLE, call('{"zone":"Asi')], then: "close" },
          { frames: [call('{"zone":"Asia/Jakarta"}'), frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })], then: "finish" },
          { frames: answer("it is noon"), then: "finish" },
        ],
        asked,
        "primary",
      ),
      { tool: clock },
    );

    expect((await result).text).toBe("it is noon");
    expect(ran).toBe(1);
    expect(asked).toEqual(["primary", "primary", "primary"]);
  });

  test("cut twice, the second cut goes to the fallback as before", async () => {
    const asked: string[] = [];
    const { result } = run(endpoint([{ frames: [ROLE], then: "socket" }], asked, "primary"), {
      fallback: endpoint([{ frames: answer("answered by claude"), then: "finish" }], asked, "claude"),
    });

    expect((await result).text).toBe("answered by claude");
    expect(asked).toEqual(["primary", "primary", "claude"]);
  });

  test("cut twice with no fallback, the turn fails as it did — asked twice, not more", async () => {
    const asked: string[] = [];
    await expect(run(endpoint([{ frames: [ROLE], then: "socket" }], asked, "primary")).result).rejects.toThrow(/stream ended mid-reply/);
    expect(asked).toEqual(["primary", "primary"]);
  });
});

describe("a stream cut after its reply began", () => {
  test("is not asked again: its words were already in front of whoever watched", async () => {
    const asked: string[] = [];
    const { result, written } = run(endpoint([{ frames: [frame({ choices: [{ delta: { content: "It is no" } }] })], then: "socket" }, { frames: answer("noon"), then: "finish" }], asked, "primary"));

    await expect(result).rejects.toThrow(/stream ended mid-reply/);
    expect(asked).toEqual(["primary"]);
    expect(written).toEqual(["It is no"]);
  });
});
