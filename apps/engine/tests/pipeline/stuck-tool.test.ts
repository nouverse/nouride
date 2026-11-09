/**
 * A tool that ignores its abort signal no longer holds the chat once the turn is stopped (`executor/stopped-call.ts`).
 *
 * `/stop` and the turn's clock only abort the turn's signal, and the executor awaited the tool directly: a tool that
 * never looked at the signal — an MCP server that never answers — kept the turn running and every later message in its
 * chat queued behind it, until the daemon restarted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatParams, LLMProvider, Tool } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, envelope, fakeAgent, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually, sleep } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const made of benches.splice(0)) made.dispose();
});

/** A tool that never settles and never looks at its signal; `calls` counts how often it was started. */
function stuckTool(): { tool: Tool; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    tool: {
      requiresApproval: false,
      definition: { name: "stuck", description: "waits on something that never answers", parameters: { type: "object", properties: {} } },
      execute: () => {
        calls += 1;
        return new Promise(() => {});
      },
    },
  };
}

/** Resolves to what came first: the promise, or `ms` passing. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | "still waiting"> {
  return await Promise.race([promise, sleep(ms).then(() => "still waiting" as const)]);
}

describe("a stopped turn whose tool never stops", () => {
  test("ends within the grace, says the call may still be running, and the chat answers its next message", async () => {
    const stuck = stuckTool();
    const made = await pipelineBench({
      turns: [{ toolCalls: [{ id: "c1", name: "stuck", args: {} }] }, { text: "here again" }],
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["stuck"]\n',
      gateway: new FakeGateway("telegram:nouva"),
      deps: { approvals: new AutoApprovalGate(), stoppedCallGraceMs: 50 },
    });
    benches.push(made);
    const { pipeline, gateway, requests } = made;
    pipeline.setTools(new Map([["stuck", stuck.tool]]));
    pipeline.attach();

    gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "check on it", timestamp: Date.now() }));
    await eventually(() => stuck.calls() === 1, 4_000, "the tool to start");
    // What `/stop` does: abort the turn's signal.
    expect(pipeline.cancelTurnFor("nouva", "814")).toBe(true);

    expect(await within(2_000, pipeline.idle())).not.toBe("still waiting");
    // Nothing more was asked of the model for the stopped turn.
    expect(requests).toHaveLength(1);

    // The queue for that chat is free: the next message is answered.
    gateway.receive(envelope({ id: "m2", gatewayId: "telegram:nouva", chatId: "814", text: "are you there?", timestamp: Date.now() }));
    expect(await within(2_000, pipeline.idle())).not.toBe("still waiting");
    expect(gateway.lastText()).toBe("here again");
    // The call was answered as stopped, in the conversation the next turn read.
    const told = JSON.stringify(requests[1]?.messages ?? []);
    expect(told).toContain("Stopped: this turn was stopped while stuck was running, and it did not stop within");
    expect(told).toContain("It may still be running in the background.");
  });
});

describe("the turn's clock, with a tool that never stops", () => {
  test("ends the turn within the grace of the clock running out", async () => {
    const stuck = stuckTool();
    let asked = 0;
    const provider = {
      async chat(params: ChatParams) {
        asked += 1;
        return asked === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "stuck", arguments: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 1, estimated: true }, model: params.model }
          : { text: "never asked", toolCalls: [], stopReason: "stop", usage: { inputTokens: 0, outputTokens: 1, estimated: true }, model: params.model };
      },
    } as unknown as LLMProvider;
    const toolset = {
      definitions: [stuck.tool.definition],
      get: (name: string) => (name === "stuck" ? stuck.tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    // The clock: what `turnClock` does when the turn's time is up — abort the turn's signal.
    const clock = new AbortController();
    setTimeout(() => clock.abort(), 50);

    const started = Date.now();
    const run = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      stoppedCallGraceMs: 100,
    }).run({
      agent: fakeAgent(), provider, toolset, history: [], signal: clock.signal,
      userMessage: { role: "user", content: "wait for it", timestamp: 1 },
      gateway: "web", gatewayId: "web:dashboard", chatId: "chat-1", chatType: "dm", sessionId: "s1", senderId: "u1",
    });

    const result = await within(2_000, run);
    expect(result).not.toBe("still waiting");
    if (result === "still waiting") return;
    // The clock (50ms) and the grace (100ms), and not much more.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(asked).toBe(1);
    const answer = result.messages.find((message) => message.toolCallId === "c1");
    expect(String(answer?.content)).toStartWith("Stopped: this turn was stopped while stuck was running");
  });

  test("a tool that stops by itself within the grace is answered with its own result", async () => {
    let asked = 0;
    const provider = {
      async chat(params: ChatParams) {
        asked += 1;
        return { text: "", toolCalls: [{ id: "c1", name: "listens", arguments: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 1, estimated: true }, model: params.model };
      },
    } as unknown as LLMProvider;
    const listens: Tool = {
      requiresApproval: false,
      definition: { name: "listens", description: "stops when told", parameters: { type: "object", properties: {} } },
      execute: async (_args, ctx) =>
        await new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ content: "cancelled cleanly", isError: true }), { once: true })),
    };
    const toolset = {
      definitions: [listens.definition],
      get: (name: string) => (name === "listens" ? listens : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const clock = new AbortController();
    setTimeout(() => clock.abort(), 30);

    const result = await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      stoppedCallGraceMs: 1_000,
    }).run({
      agent: fakeAgent(), provider, toolset, history: [], signal: clock.signal,
      userMessage: { role: "user", content: "wait for it", timestamp: 1 },
      gateway: "web", gatewayId: "web:dashboard", chatId: "chat-1", chatType: "dm", sessionId: "s1", senderId: "u1",
    });

    expect(asked).toBe(1);
    expect(String(result.messages.find((message) => message.toolCallId === "c1")?.content)).toBe("cancelled cleanly");
  });
});
