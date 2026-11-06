/**
 * Which calls in one batch run together, and which never do.
 *
 * The grouping rule is in `executor/tool-batching.ts`. What is pinned here is the part that would be
 * expensive to get wrong: a write is never concurrent with anything, the model's ordering survives,
 * and a call that can stop for a human stays alone.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool, ToolCall } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { groupParallelCalls } from "@/modules/llm/executor/tool-batching.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { createAskAgentTool } from "@/modules/tools/builtins/ask-agent.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";
import { sleep } from "../wait.ts";

const call = (name: string, id = name): ToolCall => ({ id, name, arguments: {} });
const names = (groups: ToolCall[][]) => groups.map((g) => g.map((c) => c.name));

/** Everything read-only is safe; everything else is not. The executor's real predicate also checks approvals. */
const safe = (c: ToolCall) => ["read", "glob", "grep", "web_fetch", "memory_read"].includes(c.name);

describe("grouping a batch", () => {
  test("consecutive safe calls become one group", () => {
    const groups = groupParallelCalls([call("read", "a"), call("read", "b"), call("grep")], safe);
    expect(names(groups)).toEqual([["read", "read", "grep"]]);
  });

  test("a write splits the run, and is alone", () => {
    // The old comment was right about this half: two tools writing the same file in one batch is a
    // race nobody asked for.
    const groups = groupParallelCalls(
      [call("read", "a"), call("read", "b"), call("write"), call("read", "c")],
      safe,
    );
    expect(names(groups)).toEqual([["read", "read"], ["write"], ["read"]]);
  });

  test("two writes stay two groups rather than becoming one", () => {
    const groups = groupParallelCalls([call("write", "w1"), call("edit"), call("write", "w2")], safe);
    expect(names(groups)).toEqual([["write"], ["edit"], ["write"]]);
  });

  test("order is never rearranged to make a bigger group", () => {
    // The model's ordering is information: read → write → read means it wants to see its own change.
    // Sorting the safe calls forward would break that silently, which is why grouping is consecutive.
    const groups = groupParallelCalls([call("read", "before"), call("write"), call("read", "after")], safe);
    expect(groups[0]![0]!.id).toBe("before");
    expect(groups[1]![0]!.name).toBe("write");
    expect(groups[2]![0]!.id).toBe("after");
  });

  test("a lone safe call is still a group of one", () => {
    // So the common path stays the old code path exactly — a `Promise.all` of one buys nothing.
    expect(names(groupParallelCalls([call("read")], safe))).toEqual([["read"]]);
  });

  test("nothing safe means nothing grouped", () => {
    const groups = groupParallelCalls([call("exec", "e1"), call("exec", "e2")], safe);
    expect(names(groups)).toEqual([["exec"], ["exec"]]);
  });

  test("an empty batch produces no groups", () => {
    expect(groupParallelCalls([], safe)).toEqual([]);
  });

  test("a call that can stop for a human is never grouped", () => {
    // The executor's predicate is `parallelSafe && !requiresApproval`. Modelled here by refusing the
    // one name an operator has gated: two approval prompts racing into one chat is the visible half of
    // getting this wrong, and `lastApprovalWaitMs` reporting another call's answer is the invisible one.
    const gated = (c: ToolCall) => safe(c) && c.name !== "web_fetch";
    const groups = groupParallelCalls(
      [call("read"), call("web_fetch"), call("grep")],
      gated,
    );
    expect(names(groups)).toEqual([["read"], ["web_fetch"], ["grep"]]);
  });
});

/**
 * And the part that would be easy to claim without checking: they actually overlap.
 *
 * Two slow read-only calls in one batch. Serialized they take 2x; concurrent they take 1x, and the
 * peak-concurrency counter is what proves which happened — a duration assertion alone would pass on a
 * fast machine that serialized.
 */
describe("the executor runs a parallel-safe group concurrently", () => {
  /** A tool that takes `ms` and records how many copies of itself are in flight. */
  function slowTool(name: string, parallelSafe: boolean, ms: number, state: { running: number; peak: number }): Tool {
    return {
      requiresApproval: false,
      parallelSafe,
      definition: { name, description: "slow", parameters: { type: "object", properties: {} } },
      async execute() {
        state.running += 1;
        state.peak = Math.max(state.peak, state.running);
        await sleep(ms);
        state.running -= 1;
        return { content: "done", isError: false };
      },
    };
  }

  function toolsetWith(tool: Tool): AgentToolset {
    return {
      definitions: [tool.definition],
      get: (name: string) => (name === tool.definition.name ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: (name: string) => name === tool.definition.name && tool.parallelSafe === true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as AgentToolset;
  }

  /** Answers one batch of two calls to `name`, then a final message. */
  function twoCallProvider(
    name: string,
    args: [Record<string, unknown>, Record<string, unknown>] = [{}, {}],
  ): LLMProvider {
    let asked = 0;
    return {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        asked += 1;
        if (asked === 1) {
          return {
            text: "",
            toolCalls: [
              { id: "c1", name, arguments: args[0] },
              { id: "c2", name, arguments: args[1] },
            ],
            stopReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "gpt-4",
          } as ChatResponse;
        }
        return {
          text: "both done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "gpt-4",
        } as ChatResponse;
      },
    } as unknown as LLMProvider;
  }

  const executorFor = () =>
    new TurnExecutor({
      llm: {
        defaults: { provider: "test", model: "m" },
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: {
          maxContextRatio: 0.8,
          truncationStrategy: "sliding_window",
          preserveRecentTurns: 1,
          summaryModel: undefined,
          compactAtRatio: 0.9,
          preserveRecentToolResults: 3,
        },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    });

  const request = (provider: LLMProvider, toolset: AgentToolset) => ({
    agent: fakeAgent(),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user" as const, content: "do both", timestamp: 1 },
    gateway: "telegram" as const,
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm" as const,
    sessionId: "s1",
    senderId: "u1",
  });

  test("two parallel-safe calls overlap", async () => {
    const state = { running: 0, peak: 0 };
    const tool = slowTool("read", true, 40, state);

    const result = await executorFor().run(request(twoCallProvider("read"), toolsetWith(tool)));

    expect(state.peak).toBe(2);
    expect(result.toolCalls).toBe(2);
    // Both results still reach the model, in call order — a batch that loses one poisons the
    // conversation, because a `tool_use` with no `tool_result` is rejected by both providers.
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(result.text).toBe("both done");
  });

  test("two calls that are not marked stay serialized", async () => {
    const state = { running: 0, peak: 0 };
    const tool = slowTool("exec", false, 20, state);

    await executorFor().run(request(twoCallProvider("exec"), toolsetWith(tool)));

    expect(state.peak).toBe(1);
  });

  /**
   * The tool this rule was costing the most, with its real flag rather than a stand-in.
   *
   * `ask_agent` was not marked, so `nouva` asking `nix` and `nexa` in one message ran them one after
   * the other: 37s + 38s where the chat showed two peers "in progress" and only one ever was. It was
   * kept serialized because a peer turn can stop for a human — which is true, and is a fact about the
   * person rather than about the calls. That half now lives in `tools/approval-floor.ts`.
   */
  describe("two agents asked at once", () => {
    /** The real tool, with a peer turn that takes `ms` and counts how many are in flight. */
    function askAgentTool(ms: number, state: { running: number; peak: number }, failing?: string) {
      return createAskAgentTool({
        peers: () => ["nix", "nexa"],
        run: async (req) => {
          state.running += 1;
          state.peak = Math.max(state.peak, state.running);
          await sleep(ms);
          state.running -= 1;
          if (req.to === failing) throw new Error("the peer blew up");
          return {
            agentId: req.to,
            status: "success" as const,
            summary: `${req.to} finished`,
            files: [],
            spills: [],
            metrics: { toolCalls: 1, steps: 1, ms },
          };
        },
      });
    }

    const twoPeers = () =>
      twoCallProvider("ask_agent", [
        { agent: "nix", task: "check the build" },
        { agent: "nexa", task: "check the deploy" },
      ]);

    test("they run at the same time", async () => {
      const state = { running: 0, peak: 0 };
      const result = await executorFor().run(
        request(twoPeers(), toolsetWith(askAgentTool(40, state))),
      );

      expect(state.peak).toBe(2);
      expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    });

    test("one peer failing does not take the other down with it", async () => {
      // The generic form of "deny one is not deny all": a peer that is refused — by a human, or by
      // anything else — comes back as a tool result the model can adapt to, and the peer beside it
      // finishes normally. A rejection that escaped would lose both answers and poison the
      // conversation, because a `tool_use` with no `tool_result` is rejected by both providers.
      const state = { running: 0, peak: 0 };
      const result = await executorFor().run(
        request(twoPeers(), toolsetWith(askAgentTool(20, state, "nix"))),
      );

      expect(state.peak).toBe(2);
      const results = result.messages.filter((m) => m.role === "tool");
      expect(results).toHaveLength(2);
      expect(results.map((m) => m.content).join("\n")).toContain("nexa finished");
    });
  });
});

describe("a parallel group is announced as one", () => {
  test("onBatch gets one line per call, before the calls, and only for a real group", async () => {
    const batches: string[][] = [];
    const notes: string[] = [];
    const tool: Tool = {
      requiresApproval: false,
      parallelSafe: true,
      definition: { name: "read", description: "r", parameters: { type: "object", properties: {} } },
      async execute() {
        return { content: "ok", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "read" ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        asked += 1;
        const calls =
          asked === 1
            ? [{ id: "a", name: "read", arguments: { path: "a.ts" } }, { id: "b", name: "read", arguments: { path: "b.ts" } }]
            : asked === 2
              ? [{ id: "c", name: "read", arguments: { path: "c.ts" } }]
              : [];
        return {
          text: calls.length ? "" : "done",
          toolCalls: calls,
          stopReason: calls.length ? "tool_calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
        } as ChatResponse;
      },
    } as unknown as LLMProvider;
    const executor = new TurnExecutor({
      llm: {
        defaults: { provider: "test", model: "m" },
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onBatch: (lines) => batches.push(lines),
      onActivity: (kind, text) => {
        if (kind === "note") notes.push(text);
      },
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

    // The pair ran as a group; the lone read in the next round is not a batch.
    expect(batches).toEqual([["read a.ts", "read b.ts"]]);
    // And the record gets it as a note, once.
    expect(notes.filter((note) => note === "2 calls at once")).toHaveLength(1);
  });
});
