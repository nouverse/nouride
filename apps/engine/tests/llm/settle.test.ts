/**
 * When a round may start and what a turn owes before it ends — `executor/settle.ts`.
 *
 * The rules were inline in the loop; each is a decision, so each is tested as one. The end-to-end
 * behaviour (a capped turn wraps up, an empty reply is rescued) is covered through the executor in
 * `executor.test.ts` and the pipeline suite; what is pinned here is the decision table itself.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { beforeRound, SETTLE_RULES, wrapUpPrompt, type SettleState } from "@/modules/llm/executor/settle.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const round = (over: Partial<Parameters<typeof beforeRound>[0]> = {}) =>
  beforeRound({ aborted: false, toolCallCount: 0, maxTurnDurationMs: 600_000, now: 1_000_000, ...over });

describe("before a round", () => {
  test("an aborted turn stops, whatever else is true", () => {
    expect(round({ aborted: true, toolCallCount: 5, deadlineAt: 0 }).kind).toBe("stop");
  });

  test("out of time with work behind it wraps up, asking for a report", () => {
    const decision = round({ toolCallCount: 3, deadlineAt: 1_000_000 + 1_000 });
    expect(decision.kind).toBe("wrap_up");
    if (decision.kind === "wrap_up") {
      expect(decision.reason).toBe("turn deadline");
      expect(decision.instruction).toContain("out of time");
    }
  });

  test("out of time with nothing done yet proceeds — there is nothing to summarize", () => {
    expect(round({ toolCallCount: 0, deadlineAt: 1_000_000 + 1_000 }).kind).toBe("proceed");
  });

  test("time left, or no deadline at all, proceeds", () => {
    expect(round({ toolCallCount: 3, deadlineAt: 1_000_000 + 590_000 }).kind).toBe("proceed");
    expect(round({ toolCallCount: 3 }).kind).toBe("proceed");
  });
});

describe("before a turn is over", () => {
  const settled: SettleState = {
    iterations: 2,
    maxIterations: 25,
    stopReason: "stop",
    finalText: "done",
    toolCallCount: 2,
    aborted: false,
  };
  const fired = (over: Partial<SettleState>) =>
    SETTLE_RULES.map((rule) => rule({ ...settled, ...over })?.reason ?? null).filter(Boolean);

  test("a turn that answered owes nothing", () => {
    expect(fired({})).toEqual([]);
  });

  test("running out of rounds mid-request is wrapped up", () => {
    expect(fired({ iterations: 25, stopReason: "tool_calls" })).toEqual(["iteration cap"]);
  });

  test("the last round finishing cleanly at the cap is not a cap", () => {
    // `stopReason` is what distinguishes them: at "stop" the model had already answered.
    expect(fired({ iterations: 25, stopReason: "stop" })).toEqual([]);
  });

  test("work followed by silence gets one more chance to speak", () => {
    expect(fired({ finalText: "  \n" })).toEqual(["empty reply after tool calls"]);
  });

  test("silence with no work behind it, or after an abort, is left alone", () => {
    expect(fired({ finalText: "", toolCallCount: 0 })).toEqual([]);
    expect(fired({ finalText: "", aborted: true })).toEqual([]);
  });

  test("the cap is checked before the empty reply, in that order", () => {
    expect(fired({ iterations: 25, stopReason: "tool_calls", finalText: "" })).toEqual([
      "iteration cap",
      "empty reply after tool calls",
    ]);
  });
});

/**
 * The gate fails closed, and that is the property a tool-call hook would have been built to give.
 *
 * The RFC this work came from proposed a `tool_call` hook that blocks when it throws. The gate already
 * behaves that way — a gate that throws means the tool never runs — so this pins that instead of
 * adding a hook with nothing to call it.
 */
describe("a gate that throws", () => {
  test("never lets the tool run", async () => {
    let ran = false;
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "danger", description: "x", parameters: { type: "object", properties: {} } },
      async execute() {
        ran = true;
        return { content: "ran", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "danger" ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => {
        throw new Error("policy exploded");
      },
      blockedPatterns: [],
    } as unknown as AgentToolset;
    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        asked += 1;
        return (asked === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "danger", arguments: {} }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
          : { text: "after", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }) as ChatResponse;
      },
    } as unknown as LLMProvider;
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

    await executor
      .run({
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
      })
      .catch(() => undefined);

    expect(ran).toBe(false);
  });
});

describe("the wrap-up after a background job starts", () => {
  test("an agent another one asked is told the job's end goes to that one, and promises no follow-up (0.8.8)", () => {
    // On 0.8.7 Nero, asked by Nix, answered "I'll follow up when the scan finishes": the scan's end went to Nix.
    const asked = wrapUpPrompt("background_started", { asked: true });
    expect(asked).toContain("the job's end is reported to that agent, not to you, and you are not woken when it finishes");
    expect(asked).toContain("Do not promise to follow up");
    expect(asked).not.toContain("you will follow up with the result");
    expect(wrapUpPrompt("background_started")).toContain("you will follow up with the result when it finishes");
  });
});
