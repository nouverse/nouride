/**
 * The estimate the context guard decides by, scaled to what the provider counts (M8).
 *
 * The estimator counts characters, and a log of timestamps and ids tokenized at 2.3x it on the box. Only the
 * compaction after a reply corrected for that. The window a turn started with and the guard before every
 * round of its tool loop used the raw estimate, with the provider's count in hand — so a log-heavy turn
 * carried 2.3x the tool output it was allowed before trimming any.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatParams, ChatResponse, LLMProvider, StreamChunk, TokenUsage, Tool, ToolCall } from "@nouride/shared";
import { messageText } from "@nouride/shared";
import { estimateMessagesTokens, estimateTokens, estimateToolsTokens, flattenSystem } from "@nouride/llm";
import { measuredScale, TokenScales } from "@/modules/llm/context-scale.ts";
import { ceilingsAt, type WindowFacts } from "@/modules/llm/executor/prepare.ts";
import { MAX_TOOL_RESULT_TOKENS } from "@/modules/llm/executor/types.ts";
import { TurnExecutor, type ExecutorDeps } from "@/modules/llm/executor/index.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

describe("what a provider counted, per estimated token", () => {
  test("is what it reported over what we estimated for the same request", () => {
    // The box's log: 14,000 billed for a request estimated at 6,104.
    expect(measuredScale(6_104, 14_000)).toBeCloseTo(2.29, 2);
  });

  test("never below one, never above four, and nothing is learned from nothing", () => {
    // Prose tokenizes sparser than the estimate on purpose; that is no reason to carry more.
    expect(measuredScale(10_000, 7_000)).toBe(1);
    // Past one token a character, the provider is reporting something other than this request.
    expect(measuredScale(1_000, 50_000)).toBe(4);
    expect(measuredScale(0, 5_000)).toBeUndefined();
    expect(measuredScale(5_000, 0)).toBeUndefined();
  });
});

describe("each conversation's scale, kept for its next turn", () => {
  test("is the estimate as it is until measured, and belongs to the model it was measured on", () => {
    const scales = new TokenScales();
    expect(scales.get("s1", "gemini-3.8-flash")).toBe(1);
    scales.set("s1", "gemini-3.8-flash", 2.3);
    expect(scales.get("s1", "gemini-3.8-flash")).toBe(2.3);
    // `/model` points at another tokenizer: it starts again from the estimate.
    expect(scales.get("s1", "claude-opus-5-5")).toBe(1);
    expect(scales.get("s2", "gemini-3.8-flash")).toBe(1);
  });

  test("a conversation that measured nothing starts from its agent's, on the same model only", () => {
    const scales = new TokenScales();
    scales.setForAgent("nouva", "claude-sonnet-5-5", 1.56);
    // A new chat, or any chat after a restart: its agent's prompt and tools are what it will send most of.
    expect(scales.get("new-chat", "claude-sonnet-5-5", "nouva")).toBe(1.56);
    expect(scales.get("new-chat", "gemini-3.8-flash", "nouva")).toBe(1);
    expect(scales.get("new-chat", "claude-sonnet-5-5", "nox")).toBe(1);
    // What the conversation measured itself comes first.
    scales.set("new-chat", "claude-sonnet-5-5", 2.3);
    expect(scales.get("new-chat", "claude-sonnet-5-5", "nouva")).toBe(2.3);
  });

  test("has a ceiling: the conversation measured longest ago gives way", () => {
    const scales = new TokenScales();
    for (let n = 0; n <= 1_000; n += 1) scales.set(`s${n}`, "m", 2);
    expect(scales.get("s0", "m")).toBe(1);
    expect(scales.get("s1", "m")).toBe(2);
    expect(scales.get("s1000", "m")).toBe(2);
  });
});

describe("a turn's ceilings, at a scale", () => {
  const facts: WindowFacts = {
    contextWindow: 200_000,
    maxContextRatio: 0.8,
    promptTokens: 20_000,
    toolsTokens: 5_000,
    maxOutputTokens: 8_192,
    compactAtRatio: 0.8,
    totalLimit: { tokens: 160_000, source: "model:default" },
    summaryModel: "m",
    summarizerWindow: 200_000,
  };
  const overhead = facts.promptTokens + facts.toolsTokens;

  test("at one, are the numbers the raw estimate always got", () => {
    const usable = Math.floor(facts.contextWindow * facts.maxContextRatio);
    const budget = usable - overhead - facts.maxOutputTokens;
    const at = ceilingsAt(facts, 1);
    expect(at.budget).toBe(budget);
    expect(at.compactAt).toBe(Math.min(Math.floor(budget * 0.8), facts.totalLimit.tokens - overhead));
    expect(at.toolResultCap).toBe(MAX_TOOL_RESULT_TOKENS);
    expect(at.compaction).toEqual({ threshold: at.compactAt, limit: at.compactAt, totalLimit: 160_000, source: "model:default", summaryModel: "m", summarizerWindow: 200_000 });
  });

  test("at 2.3, every limit holds at the provider's count rather than at 2.3x it", () => {
    const scale = 2.3;
    const usable = Math.floor(facts.contextWindow * facts.maxContextRatio);
    const at = ceilingsAt(facts, scale);

    // The history the budget allows, with the prompt and tools beside it and the answer reserved, fills the
    // window as the provider counts it — up to rounding, and no further.
    const counted = (at.budget + overhead) * scale + facts.maxOutputTokens;
    expect(counted).toBeLessThanOrEqual(usable);
    expect(counted).toBeGreaterThan(usable - 2 * scale);
    // One tool result costs at most the hard ceiling on every request after it, counted as the provider does.
    expect(at.toolResultCap * scale).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
    expect(at.toolResultCap * scale).toBeGreaterThan(MAX_TOOL_RESULT_TOKENS - scale);
    expect(at.compactAt).toBeLessThan(ceilingsAt(facts, 1).compactAt);
    expect(at.compaction.summarizerWindow * scale).toBeLessThanOrEqual(facts.summarizerWindow);
  });

  test("a whole-request ceiling is the provider's number: the history it leaves holds at the provider's count", () => {
    const wide: WindowFacts = { ...facts, contextWindow: 1_000_000, totalLimit: { tokens: 200_000, source: "model:gemini-flash" } };
    const scale = 2.3;
    const at = ceilingsAt(wide, scale);
    expect((at.compactAt + overhead) * scale).toBeLessThanOrEqual(200_000);
    expect((at.compactAt + overhead) * scale).toBeGreaterThan(200_000 - 2 * scale);
  });
});

/**
 * A provider whose tokenizer counts `factor` tokens for every one the estimator counts — what a log of
 * timestamps and ids does. Reports it as its own count, unless it is the kind that reports nothing: then the
 * client fills one in from its own estimate, flagged `estimated`, the way `fillMissingUsage` does.
 */
function countingProvider(factor: number, script: { text?: string; calls?: ToolCall[] }[], options: { silent?: boolean } = {}) {
  const requests: ChatParams[] = [];
  let index = 0;
  const usage = (params: ChatParams): TokenUsage => {
    const estimate = estimateTokens(flattenSystem(params.system)) + estimateMessagesTokens(params.messages) + estimateToolsTokens(params.tools ?? []);
    return options.silent
      ? { inputTokens: Math.round(estimate * factor), outputTokens: 5, estimated: true }
      : { inputTokens: Math.round(estimate * factor), outputTokens: 5 };
  };
  const next = () => script[Math.min(index++, script.length - 1)]!;
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(params: ChatParams): Promise<ChatResponse> {
      requests.push(params);
      const step = next();
      return { text: step.text ?? "", toolCalls: step.calls ?? [], stopReason: step.calls?.length ? "tool_calls" : "stop", usage: usage(params), model: "gpt-4o" };
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      requests.push(params);
      const step = next();
      if (step.text) yield { type: "text", delta: step.text };
      for (const call of step.calls ?? []) yield { type: "tool_call", call };
      yield { type: "usage", usage: usage(params) };
      yield { type: "done", stopReason: step.calls?.length ? "tool_calls" : "stop" };
    },
  } as unknown as LLMProvider;
  return { provider, requests };
}

/** A tool that returns ~8,000 estimated tokens a call, and remembers how much it was told it may return. */
function dumpTool(told: number[]): AgentToolset {
  let call = 0;
  const tool: Tool = {
    requiresApproval: false,
    definition: { name: "dump", description: "returns a lot", parameters: { type: "object", properties: {} } },
    async execute(_args, ctx) {
      call += 1;
      if (ctx.resultChars !== undefined) told.push(ctx.resultChars);
      // Many lines, so a spill keeps whole ones.
      return { content: `PAYLOAD-${call}\n${Array.from({ length: 800 }, () => "x".repeat(39)).join("\n")}`, isError: false };
    },
  };
  return {
    definitions: [tool.definition],
    get: (name) => (name === "dump" ? tool : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  };
}

const emptyToolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };

const dumps = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ calls: [{ id: `c${i + 1}`, name: "dump", arguments: {} }] })),
  { text: "done" },
];

const spillDirs: string[] = [];
afterAll(() => {
  for (const dir of spillDirs) rmSync(dir, { recursive: true, force: true });
});

function executor(overrides: Partial<ExecutorDeps> & { strategy?: "summary" | "sliding_window"; compactAtRatio?: number; streaming?: boolean } = {}) {
  const { strategy = "sliding_window", compactAtRatio = 0.9, streaming = true, ...deps } = overrides;
  return new TurnExecutor({
    llm: {
      streaming: { enabled: streaming, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 8, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: strategy, preserveRecentTurns: 4, summaryModel: undefined, compactAtRatio, preserveRecentToolResults: 1 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    ...deps,
  });
}

function agent(llm: { contextWindow: number; compactAtTokens?: number }) {
  const loaded = fakeAgent();
  loaded.config.llm = { provider: "test", model: "gpt-4o", maxTokens: 1_000, temperature: 0, ...llm };
  return loaded;
}

function run(exec: TurnExecutor, provider: LLMProvider, options: { toolset?: AgentToolset; history?: ChatMessage[]; window?: number; compactAtTokens?: number; sessionId?: string } = {}) {
  return exec.run({
    agent: agent({ contextWindow: options.window ?? 1_000_000, ...(options.compactAtTokens ? { compactAtTokens: options.compactAtTokens } : {}) }),
    provider,
    toolset: options.toolset ?? emptyToolset,
    history: options.history ?? [],
    userMessage: { role: "user", content: "dump all of it", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: options.sessionId ?? "session-1",
    senderId: "user-1",
  });
}

const carries = (request: ChatParams | undefined, marker: string) =>
  (request?.messages ?? []).some((message) => message.role === "tool" && messageText(message.content).startsWith(marker));

describe("the guard before every round", () => {
  /**
   * A 60k whole-request ceiling on a million-token window, so the ceiling is what binds: ~54k of history
   * by the estimate, ~19k once the provider is known to count 2.5 tokens for each. Four results of ~8k.
   */
  const turn = (factor: number, options: { silent?: boolean } = {}) => {
    const { provider, requests } = countingProvider(factor, dumps(4), options);
    return run(executor(), provider, { toolset: dumpTool([]), compactAtTokens: 60_000 }).then((result) => ({ result, requests }));
  };

  test("trims at the provider's count: what the estimate alone would carry whole is cut down", async () => {
    // A provider counting fewer tokens than we estimate changes nothing: the scale never goes below one.
    const raw = await turn(0.9);
    const dense = await turn(2.5);

    // By the estimate, four results fit: the last request carries every one.
    expect(["PAYLOAD-1", "PAYLOAD-2", "PAYLOAD-3", "PAYLOAD-4"].every((marker) => carries(raw.requests[4], marker))).toBe(true);
    // At what the provider counts, the oldest go — and the newest, which the model is working from, stays.
    expect(carries(dense.requests[4], "PAYLOAD-1")).toBe(false);
    expect(carries(dense.requests[4], "PAYLOAD-4")).toBe(true);
    expect(dense.result.tokenScale).toBeCloseTo(2.5, 2);
    expect(raw.result.tokenScale).toBe(1);
  });

  test("learns nothing from a provider that reported nothing — an estimate flagged as one is not a count", async () => {
    const silent = await turn(2.5, { silent: true });
    expect(silent.result.tokenScale).toBe(1);
    expect(carries(silent.requests[4], "PAYLOAD-1")).toBe(true);
  });

  test("on the non-streaming path as well", async () => {
    const { provider, requests } = countingProvider(2.5, dumps(4));
    const result = await run(executor({ streaming: false }), provider, { toolset: dumpTool([]), compactAtTokens: 60_000 });
    expect(result.tokenScale).toBeCloseTo(2.5, 2);
    expect(carries(requests[4], "PAYLOAD-1")).toBe(false);
  });
});

describe("one tool result's ceiling", () => {
  test("is what one result may cost as the provider counts it, once a call has said how it counts", async () => {
    const told = async (factor: number) => {
      const dir = mkdtempSync(join(tmpdir(), "nouride-scale-spill-"));
      spillDirs.push(dir);
      const chars: number[] = [];
      const { provider } = countingProvider(factor, dumps(1));
      await run(executor({ spill: new ToolOutputSpill(dir) }), provider, { toolset: dumpTool(chars) });
      return chars[0]!;
    };

    // Four characters an estimated token, so the hard ceiling of 12k tokens is 48k characters at face value…
    expect(await told(0.9)).toBe(MAX_TOOL_RESULT_TOKENS * 4);
    // …and a 2.5th of it once the provider has counted 2.5 tokens for each of ours.
    const dense = (MAX_TOOL_RESULT_TOKENS * 4) / 2.5;
    expect(Math.abs((await told(2.5)) - dense)).toBeLessThan(dense / 100);
  });
});

describe("a turn starts where the conversation's last count left it", () => {
  /** Ten turns of ~1k estimated tokens each — a window that holds them by the estimate and not at 3x. */
  const history = (): ChatMessage[] =>
    Array.from({ length: 10 }, (_, i) => [
      { role: "user" as const, content: `turn ${i} ${"y".repeat(3_900)}`, timestamp: i * 2 },
      { role: "assistant" as const, content: `answered ${i}`, timestamp: i * 2 + 1 },
    ]).flat();

  const twoTurns = async (factor: number, scales: TokenScales | undefined) => {
    const exec = executor(scales ? { tokenScales: scales } : {});
    const first = countingProvider(factor, [{ text: "first" }]);
    const one = await run(exec, first.provider, { history: history(), window: 40_000 });
    const second = countingProvider(factor, [{ text: "second" }]);
    await run(exec, second.provider, { history: one.messages, window: 40_000 });
    return { first: first.requests[0]!, second: second.requests[0]! };
  };

  test("so a history that tokenizes at 3x is cut before the first call of the next turn, not after it", async () => {
    const scales = new TokenScales();
    const dense = await twoTurns(3, scales);
    const raw = await twoTurns(0.9, new TokenScales());

    // The first turn of each knew nothing yet and sent the whole history.
    expect(dense.first.messages.length).toBe(raw.first.messages.length);
    expect(scales.get("session-1", "gpt-4o")).toBeCloseTo(3, 2);
    // The second started from what the first measured: the oldest turns are left out of its first request.
    expect(dense.second.messages.length).toBeLessThan(raw.second.messages.length);
    expect(messageText(dense.second.messages[0]!.content)).not.toStartWith("turn 0 ");
    expect(messageText(raw.second.messages[0]!.content)).toStartWith("turn 0 ");
  });

  test("without a place to keep it, each turn starts from the estimate — and still corrects from its own first call", async () => {
    const unkept = await twoTurns(3, undefined);
    const raw = await twoTurns(0.9, undefined);
    expect(unkept.second.messages.length).toBe(raw.second.messages.length);
  });
});

describe("a new conversation starts where its agent's last count left it", () => {
  const id = agent({ contextWindow: 1 }).config.id;
  const history = (): ChatMessage[] =>
    Array.from({ length: 10 }, (_, i) => [
      { role: "user" as const, content: `turn ${i} ${"y".repeat(3_900)}`, timestamp: i * 2 },
      { role: "assistant" as const, content: `answered ${i}`, timestamp: i * 2 + 1 },
    ]).flat();

  test("so a new chat's first request is decided at the agent's count, not the raw estimate (2026-10-24: 31,391 said, 48,950 counted)", async () => {
    const measuredFirst = async (scales: TokenScales, teach: boolean) => {
      const exec = executor({ tokenScales: scales });
      // A first message in another chat: the prompt and tools outweigh a one-line history.
      if (teach) await run(exec, countingProvider(3, [{ text: "hi" }]).provider, { sessionId: "chat-a" });
      const next = countingProvider(3, [{ text: "second chat" }]);
      await run(exec, next.provider, { sessionId: "chat-b", history: history(), window: 40_000 });
      return next.requests[0]!;
    };
    const taught = new TokenScales();
    const known = await measuredFirst(taught, true);
    const unknown = await measuredFirst(new TokenScales(), false);

    expect(taught.get("chat-z", "gpt-4o", id)).toBeCloseTo(3, 2);
    // At the agent's 3x the history does not fit, and its oldest turns are left out of the very first request.
    expect(known.messages.length).toBeLessThan(unknown.messages.length);
    expect(messageText(unknown.messages[0]!.content)).toStartWith("turn 0 ");
  });

  test("a request its history outweighs teaches its own conversation, not the agent: a log-heavy chat measures its log", async () => {
    const scales = new TokenScales();
    await run(executor({ tokenScales: scales }), countingProvider(3, [{ text: "read it" }]).provider, { sessionId: "chat-log", history: history() });
    expect(scales.get("chat-log", "gpt-4o", id)).toBeCloseTo(3, 2);
    expect(scales.get("chat-new", "gpt-4o", id)).toBe(1);
  });
});
