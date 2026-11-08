/**
 * Old tool output out of the history at a turn's start (0.8.13). Measured on the live box: tool
 * output was 75 % of the stored history and stayed whole until compaction, so requests grew to 100–200k first. Now
 * output older than the last two turns is cleared — the same marker and kept file as a trim — when the cache was lost
 * anyway (the prompt, the model or the tools changed, or an hour idle), or once there is enough of it to pay for the
 * rewrite. Otherwise nothing changes: two turns with no trigger between them send the same history, byte for byte.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatParams, LLMProvider } from "@nouride/shared";
import { CacheBreaks, IDLE_MS } from "@/modules/llm/cache-breaks.ts";
import { pruneToolOutputs, TRIMMED_TOOL_PREFIX } from "@/modules/llm/context.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const text = (message: ChatMessage) => (typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : "")).join(""));

/** Earlier turns, each a question, a call, its output (`size` characters) and an answer — stamped `at`. */
function earlier(turns: number, size: number, at: number): ChatMessage[] {
  return Array.from({ length: turns }, (_, n): ChatMessage[] => [
    { role: "user", content: `question ${n}`, timestamp: at },
    { role: "assistant", content: "", toolCalls: [{ id: `call_${n}`, name: "exec", arguments: { command: `cat log-${n}` } }], timestamp: at },
    { role: "tool", toolCallId: `call_${n}`, content: `output ${n}: ${"x".repeat(size)}`, timestamp: at },
    { role: "assistant", content: `answer ${n}`, timestamp: at },
  ]).flat();
}

describe("the prune, by turns", () => {
  test("output older than the last two turns goes, as kept files; the last two turns' stays whole", () => {
    const history = earlier(4, 2_000, 1);
    const kept: string[] = [];
    const { messages, pruned } = pruneToolOutputs(history, {
      protectTokens: 0,
      protectTurns: 2,
      minSavingsTokens: 1,
      keep: (message) => (kept.push(String(message.toolCallId)), { path: `/spill/${String(message.toolCallId)}.txt`, lines: 1, kb: 2 }),
    });
    expect(pruned).toBe(2);
    expect(kept.sort()).toEqual(["call_0", "call_1"]);
    const tools = messages.filter((message) => message.role === "tool").map(text);
    expect(tools[0]).toContain("kept at /spill/call_0.txt; read it with `read`");
    expect(tools[1]).toContain("kept at /spill/call_1.txt");
    expect(tools[2]).toStartWith("output 2: ");
    expect(tools[3]).toStartWith("output 3: ");
  });
});

describe("whether the cache was lost anyway", () => {
  test("unknown first, then the same prefix not, a changed one or an hour idle yes", () => {
    const breaks = new CacheBreaks();
    expect(breaks.lost("ses_1", "a", 1_000, 2_000)).toBe(false);
    expect(breaks.lost("ses_1", "a", 1_000, 2_000)).toBe(false);
    expect(breaks.lost("ses_1", "b", 1_000, 2_000)).toBe(true);
    expect(breaks.lost("ses_1", "b", 1_000, 1_000 + IDLE_MS)).toBe(true);
    // Another conversation's prefix is its own.
    expect(breaks.lost("ses_2", "a", 1_000, 2_000)).toBe(false);
  });
});

describe("at a turn's start", () => {
  /** One turn of a fresh executor over `history`: the messages its first request sent. */
  async function firstRequest(history: ChatMessage[], options: { sessionId: string; system?: string; executor?: TurnExecutor } = { sessionId: "ses_a" }) {
    const asked: ChatParams[] = [];
    const provider = {
      kind: "anthropic",
      baseUrl: "https://gw.test/v1",
      chat: async (params: ChatParams) => (asked.push(params), { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }),
      stream() {
        throw new Error("streaming is off here");
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent();
    // A window and a compaction line far above these histories: what clears here is this step, not compaction.
    agent.config.llm = { provider: "gw", model: "m", maxTokens: 128, temperature: 0.7, contextWindow: 1_000_000, compactAtTokens: 900_000 };
    if (options.system) agent.persona.identity = options.system;
    const toolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };
    const executor =
      options.executor ??
      new TurnExecutor({
        llm: {
          streaming: { enabled: false, typingIndicator: false, progressInChat: false },
          limits: { maxToolIterations: 2, maxTokensPerTurn: 1024 },
          context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
        } as never,
        approvals: new AutoApprovalGate(),
        timezone: "UTC",
        commands: [],
      });
    await executor.run({
      agent, provider, toolset, history,
      userMessage: { role: "user", content: "and now?", timestamp: Date.now() },
      gateway: "telegram", gatewayId: "telegram:main", chatId: "814", chatType: "dm", sessionId: options.sessionId, senderId: "814",
    });
    return { sent: asked[0]!.messages.filter((message) => message.role === "tool").map(text), executor };
  }

  test("a warm cache and little old output: the history goes as it was — two turns, the same bytes", async () => {
    const history = earlier(4, 2_000, Date.now() - 60_000);
    const first = await firstRequest(history, { sessionId: "ses_warm" });
    const second = await firstRequest(history, { sessionId: "ses_warm", executor: first.executor });
    expect(first.sent.every((one) => one.startsWith("output "))).toBe(true);
    expect(second.sent).toEqual(first.sent);
  });

  test("an hour idle — the cache gone anyway — the output older than the last two turns goes", async () => {
    const { sent } = await firstRequest(earlier(4, 2_000, Date.now() - 2 * IDLE_MS), { sessionId: "ses_idle" });
    expect(sent[0]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(sent[1]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(sent[2]).toStartWith("output 2: ");
    expect(sent[3]).toStartWith("output 3: ");
  });

  test("the prompt changed since the last turn — the cache gone anyway — it goes too", async () => {
    const history = earlier(4, 2_000, Date.now() - 60_000);
    const first = await firstRequest(history, { sessionId: "ses_changed", system: "# IDENTITY\n- Name: Nova\n" });
    expect(first.sent[0]).toStartWith("output 0: ");
    const second = await firstRequest(history, { sessionId: "ses_changed", system: "# IDENTITY\n- Name: Nova, renamed\n", executor: first.executor });
    expect(second.sent[0]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(second.sent[3]).toStartWith("output 3: ");
  });

  test("enough old output to pay for the rewrite goes even while the cache is warm", async () => {
    const { sent } = await firstRequest(earlier(4, 60_000, Date.now() - 60_000), { sessionId: "ses_large" });
    expect(sent[0]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(sent[2]).toStartWith("output 2: ");
  });
});
