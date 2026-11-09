/**
 * The context window a gateway states for a model: what a turn is budgeted against, before the table of model
 * families and its 32k for a family it does not know — and after the pack's own `context_window`.
 *
 * Observed as what the request carries: a long conversation on a model the table does not know is cut to fit 32k, and
 * carried whole when the gateway says the model takes a million.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatParams, LLMProvider } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { contextWindowFor } from "@/modules/llm/executor/context-window.ts";
import { guessedWindows } from "@/cli/commands/doctor-checks.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const emptyToolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };

/** Sixty exchanges of ~1k tokens each by the estimate: past a 32k window, well inside a million. */
const HISTORY: ChatMessage[] = Array.from({ length: 60 }, (_, n) => [
  { role: "user" as const, content: `question ${n} ${"x".repeat(2_000)}`, timestamp: n * 2 },
  { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_000)}`, timestamp: n * 2 + 1 },
]).flat();

async function sent(options: { model?: string; override?: string; declared?: number; stated?: Record<string, number> }) {
  const requests: ChatParams[] = [];
  const provider = {
    async chat(params: ChatParams) {
      requests.push(params);
      return { text: "ok", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: params.model };
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  agent.config.llm = { provider: "nougate", model: options.model ?? "brand-new-model", maxTokens: 1_000, temperature: 0, ...(options.declared ? { contextWindow: options.declared } : {}) };
  await new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 2, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 1 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    ...(options.stated ? { windowOf: (model: string) => options.stated![model] ?? null } : {}),
  }).run({
    agent,
    provider,
    toolset: emptyToolset,
    history: HISTORY,
    userMessage: { role: "user", content: "and now?", timestamp: 1_000 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
    ...(options.override ? { model: options.override } : {}),
  });
  return requests[0]!.messages.length;
}

describe("the window a turn is budgeted against", () => {
  /** What a request carries when nothing is cut: the pack declares a window nothing here comes near. */
  const whole = () => sent({ declared: 2_000_000 });

  test("a model the table does not know is cut to its 32k when nothing says otherwise", async () => {
    expect(await sent({})).toBeLessThan(await whole());
  });

  test("is the gateway's, when it states one: the conversation goes whole", async () => {
    expect(await sent({ stated: { "brand-new-model": 1_000_000 } })).toBe(await whole());
  });

  test("is the pack's own `context_window` before the gateway's: the operator who wrote one down meant it", async () => {
    expect(await sent({ declared: 32_000, stated: { "brand-new-model": 1_000_000 } })).toBeLessThan(await whole());
  });

  test("is the gateway's for a model `/model` chose — where the pack's figure is about another model", async () => {
    expect(await sent({ declared: 32_000, override: "other-model", stated: { "other-model": 1_000_000 } })).toBe(await whole());
  });
});

describe("where the number comes from", () => {
  test("the pack for its own model, then the gateway, then the family table, else a 32k guess", () => {
    expect(contextWindowFor({ model: "m", packModel: "m", declared: 50_000, stated: 1_000_000 })).toEqual({ tokens: 50_000, source: "pack" });
    expect(contextWindowFor({ model: "other", packModel: "m", declared: 50_000, stated: 1_000_000 })).toEqual({ tokens: 1_000_000, source: "gateway" });
    expect(contextWindowFor({ model: "claude-sonnet-4-6", packModel: "claude-sonnet-4-6", stated: null })).toEqual({ tokens: 200_000, source: "table" });
    expect(contextWindowFor({ model: "brand-new-model", packModel: "brand-new-model", stated: null })).toEqual({ tokens: 32_000, source: "default" });
  });

  test("doctor says which agents run on the guess, and nothing about the rest — or about a daemon that does not say", () => {
    const checks = guessedWindows([
      { id: "nouva", model: "brand-new-model", contextWindow: { tokens: 32_000, source: "default" } },
      { id: "nox", model: "kiro:claude-opus-5.5", contextWindow: { tokens: 1_000_000, source: "gateway" } },
      { id: "old", model: "brand-new-model" },
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.level).toBe("warn");
    expect(checks[0]!.message).toBe("nouva: no known context window for brand-new-model, budgeted at 32,000 tokens");
    expect(checks[0]!.hint).toContain("[llm] context_window in agents/nouva/config.toml");
  });
});
