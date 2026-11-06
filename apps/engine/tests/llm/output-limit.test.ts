/**
 * The output limit, live (2026-10-21, turn 44d1bdd4): three calls in a row stopped at exactly 8192 output tokens — the
 * flat default — and a `write` carrying a whole document arrived as JSON that did not parse. Told only "not valid JSON,
 * send it again", the model sent the same oversized call twice more, then an `exec` with no arguments at all.
 *
 * So: the cap is the model's own unless someone set one; a call the cut left broken is answered with why and how to
 * send big content in parts; and what arrived is kept in the record, capped, so the failure can be read afterwards.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatParams, ChatResponse, LLMProvider, Tool, ToolCall } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { outputCap, plannedOutputTokens } from "@/modules/llm/output-cap.ts";
import { compactionLimitInfo, contextWindowInfo, outputLimitInfo } from "@nouride/llm";
import { ceilingsAt, type WindowFacts } from "@/modules/llm/executor/prepare.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

describe("the room a turn plans for the reply", () => {
  test("is a typical reply's, not the whole cap — the whole cap cleared tool results the agent had only just read", () => {
    // Live, 0.7.25's first run: planning for 32k took the history from ~39k to ~29k on Claude, and the agent's own
    // re-reads of its cleared output were cleared again as they arrived.
    expect(plannedOutputTokens(32_000)).toBe(8_192);
    expect(plannedOutputTokens(4_096)).toBe(4_096);
    const facts = (maxOutputTokens: number): WindowFacts =>
      ({ contextWindow: 200_000, maxContextRatio: 0.9, promptTokens: 30_000, toolsTokens: 10_000, maxOutputTokens, compactAtRatio: 0.8, totalLimit: { tokens: 160_000, source: "model" }, summaryModel: "m", summarizerWindow: 200_000 }) as WindowFacts;
    expect(ceilingsAt(facts(plannedOutputTokens(32_000)), 1.86).compactAt).toBeGreaterThan(ceilingsAt(facts(32_000), 1.86).compactAt);
  });

  test("and the whole cap still fits: each known model's compaction limit plus its cap is inside its window", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "gemini-3.8-flash-high", "gemini-2.5-pro", "gpt-5", "gpt-5.6-luna"]) {
      const total = compactionLimitInfo(model).tokens + outputLimitInfo(model).tokens;
      expect({ model, fits: total <= contextWindowInfo(model).tokens }).toEqual({ model, fits: true });
    }
  });
});

describe("outputCap", () => {
  test("a number someone wrote wins; 0 is the model's own; the ceiling is over all of it", () => {
    expect(outputCap(4096, "claude-sonnet-5-5", 32_000)).toBe(4096);
    expect(outputCap(0, "nougate:claude-sonnet-5-5", 32_000)).toBe(32_000);
    expect(outputCap(0, "gemini-3-flash", 32_000)).toBe(32_000);
    expect(outputCap(0, "some-unknown-model", 32_000)).toBe(8192);
    expect(outputCap(0, "claude-sonnet-5-5", 16_384)).toBe(16_384);
    expect(outputCap(64_000, "claude-sonnet-5-5", 32_000)).toBe(32_000);
  });

  test("the shipped defaults: by model, under a ceiling that does not cut the model's figure short", () => {
    expect(DEFAULT_CONFIG.llm.defaults.maxTokens).toBe(0);
    expect(DEFAULT_CONFIG.llm.limits.maxTokensPerTurn).toBe(32_000);
    expect(outputCap(DEFAULT_CONFIG.llm.defaults.maxTokens, "claude-sonnet-5-5", DEFAULT_CONFIG.llm.limits.maxTokensPerTurn)).toBe(32_000);
  });
});

const PARAMETERS = { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, command: { type: "string" } } };

/** A turn whose first reply is `first`, then "done" — what the second request carried, and every `tool_done` row. */
async function turn(first: Omit<ChatResponse, "usage" | "model">, maxTokens = 0) {
  const requests: ChatParams[] = [];
  const ran: Record<string, unknown>[] = [];
  const rows: Array<Record<string, unknown> | undefined> = [];
  const tool = (name: string): Tool => ({
    requiresApproval: false,
    definition: { name, description: name, parameters: PARAMETERS },
    async execute(args) {
      ran.push(args);
      return name === "exec" && typeof args.command !== "string"
        ? { content: "`command` must be a shell command string, e.g. \"git status\".", isError: true }
        : { content: "ok", isError: false };
    },
  });
  const tools = new Map([["write", tool("write")], ["exec", tool("exec")]]);
  const toolset = {
    definitions: [...tools.values()].map((t) => t.definition),
    get: (name: string) => tools.get(name),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(params: ChatParams): Promise<ChatResponse> {
      requests.push(params);
      const usage = { inputTokens: 1, outputTokens: 1 };
      return requests.length === 1 ? { ...first, usage, model: "x" } : { text: "done", toolCalls: [], stopReason: "stop", usage, model: "x" };
    },
  } as unknown as LLMProvider;
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 32_000 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity: (kind, _text, detail) => {
      if (kind === "tool_done") rows.push(detail?.audit as Record<string, unknown> | undefined);
    },
  });
  await executor.run({
    agent: fakeAgent({ config: { ...fakeAgent().config, llm: { provider: "p", model: "claude-sonnet-5-5", maxTokens, temperature: 0.7 } } }),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "write the report", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
  });
  const answers = (requests[1]?.messages ?? []).filter((message: ChatMessage) => message.role === "tool").map((message) => String(message.content));
  return { requests, answers, ran, rows };
}

const document = `{"path":"report.md","content":"${"lorem ipsum ".repeat(400)}`;
const cutWrite: ToolCall = { id: "c1", name: "write", arguments: {}, argumentsError: { raw: document.slice(0, 2048), reason: "not valid JSON (Unterminated string)" } };

describe("a reply cut at the output limit", () => {
  test("the request carries the model's own cap when the agent set none", async () => {
    const { requests } = await turn({ text: "", toolCalls: [], stopReason: "stop" });
    expect(requests[0]?.maxTokens).toBe(32_000);
  });

  test("and the agent's own when it set one", async () => {
    const { requests } = await turn({ text: "", toolCalls: [], stopReason: "stop" }, 4096);
    expect(requests[0]?.maxTokens).toBe(4096);
  });

  test("a call it left broken is told the reply was cut at that limit, and to send big content in parts", async () => {
    const { answers, ran } = await turn({ text: "", toolCalls: [cutWrite], stopReason: "tool_calls", cutAtLimit: true });
    expect(ran).toHaveLength(0);
    expect(answers[0]).toContain("Your reply was cut off at the output limit of 32000 tokens, so this write call arrived incomplete");
    expect(answers[0]).toContain("`write` with `append: true`");
    expect(answers[0]).toContain("Do not send the same call again");
    expect(answers[0]).not.toContain("Send the call again with its arguments as one JSON object");
  });

  test("not cut, the same broken call keeps the plain answer", async () => {
    const { answers } = await turn({ text: "", toolCalls: [cutWrite], stopReason: "tool_calls" });
    expect(answers[0]).toContain("Send the call again with its arguments as one JSON object");
    expect(answers[0]).not.toContain("output limit");
  });

  test("an exec that arrived empty: its own refusal, then why it was empty", async () => {
    const { answers } = await turn({ text: "", toolCalls: [{ id: "c2", name: "exec", arguments: {} }], stopReason: "tool_calls", cutAtLimit: true });
    expect(answers[0]).toContain("`command` must be a shell command string");
    expect(answers[0]).toContain("this call arrived without its arguments");
  });

  test("an exec with its arguments is not told anything about a cut", async () => {
    const { answers } = await turn({ text: "", toolCalls: [{ id: "c3", name: "exec", arguments: { command: "ls" } }], stopReason: "tool_calls", cutAtLimit: true });
    expect(answers[0]).toBe("ok");
  });

  test("what arrived is kept in the record — capped, never `{}`", async () => {
    const { rows } = await turn({ text: "", toolCalls: [cutWrite], stopReason: "tool_calls", cutAtLimit: true });
    expect(rows[0]).toMatchObject({ callId: "c1", tool: "write", error: true, args: { unparsed: document.slice(0, 2048) } });
  });
});
