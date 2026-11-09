/**
 * Who writes a compaction summary: `[llm.context] summary_model` on the agent's profile, else `[memory]`'s pass
 * model on its own profile, else the turn's own — and the turn's executor, the path every chat turn takes, asks the
 * one chosen, metered under the profile that answered.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { LLMError, type ChatMessage, type ChatParams, type ChatResponse, type GlobalConfig, type LLMProvider } from "@nouride/shared";
import { UsageStore, type UsageRecord } from "@/modules/llm/usage.store.ts";
import { summarizerFor, summarizerRoute, summarizerWindowFor } from "@/modules/llm/summarizer.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, envelope, fakeAgent, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const TURN = { profile: "anthropic", model: "claude-opus-5-5" };

describe("the route", () => {
  test("summary_model first, on the agent's own profile", () => {
    expect(summarizerRoute({ summaryModel: "claude-haiku-4-5", passProvider: "nougate", passModel: "gemini-3.8-flash" }, TURN)).toEqual({ profile: "anthropic", model: "claude-haiku-4-5" });
  });

  test("else the nightly pass's model, on the pass's profile", () => {
    expect(summarizerRoute({ passProvider: "nougate", passModel: "gemini-3.8-flash" }, TURN)).toEqual({ profile: "nougate", model: "gemini-3.8-flash" });
  });

  test("else the turn's own — and half a pass setting is no pass setting", () => {
    expect(summarizerRoute({}, TURN)).toEqual(TURN);
    expect(summarizerRoute({ passProvider: "", passModel: "" }, TURN)).toEqual(TURN);
    expect(summarizerRoute({ passModel: "gemini-3.8-flash" }, TURN)).toEqual(TURN);
  });
});

/** A provider that answers the summary call (temperature 0) and the turn alike, and says which it was asked. */
function fakeProvider(name: string, asked: { by: string; model: string; summary: boolean }[]): LLMProvider {
  return {
    kind: "openai",
    baseUrl: `https://${name}.test/v1`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const summary = params.temperature === 0;
      asked.push({ by: name, model: params.model, summary });
      return { text: summary ? "- what was decided" : "answered", toolCalls: [], stopReason: "stop", usage: { inputTokens: 10, outputTokens: 2 }, model: params.model };
    },
  } as unknown as LLMProvider;
}

const emptyToolset = {
  definitions: [],
  get: () => undefined,
  requiresApproval: () => false,
  parallelSafe: () => false,
  gate: () => ({ action: "run", via: "allowlist" }),
  blockedPatterns: [],
} as unknown as AgentToolset;

const longHistory = (): ChatMessage[] =>
  Array.from({ length: 12 }, (_, i) => [
    { role: "user" as const, content: `question ${i} ${"x".repeat(2_000)}`, timestamp: i },
    { role: "assistant" as const, content: `answer ${i} ${"y".repeat(2_000)}`, timestamp: i },
  ]).flat();

describe("a turn that compacts", () => {
  test("asks the pass's model on the pass's profile, charged there as the turn's compaction", async () => {
    const asked: { by: string; model: string; summary: boolean }[] = [];
    const recorded: UsageRecord[] = [];
    const profiles: Record<string, LLMProvider> = { anthropic: fakeProvider("anthropic", asked), nougate: fakeProvider("nougate", asked) };
    const deps = {
      config: { llm: { context: { summaryModel: undefined }, defaults: { provider: "anthropic" } }, memory: { passProvider: "nougate", passModel: "gemini-3.8-flash" } },
      providers: { get: (name: string) => profiles[name]! },
      usage: { record: (entry: UsageRecord) => void recorded.push(entry) },
    };
    const agent = fakeAgent();

    const result = await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 2, summaryModel: undefined, compactAtRatio: 0.05, compactAtTokens: 1_000, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      summarizer: summarizerFor(deps, { agentId: agent.config.id, profile: agent.config.llm.provider, sessionId: "s1", turnId: "turn_1", tiers: agent.config.llm }),
    }).run({
      agent,
      provider: profiles.anthropic!,
      toolset: emptyToolset,
      history: longHistory(),
      userMessage: { role: "user", content: "and now?", timestamp: 99 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    // The summary went to the pass's profile and model; the answer to the agent's.
    expect(asked.filter((call) => call.summary)).toEqual([{ by: "nougate", model: "gemini-3.8-flash", summary: true }]);
    expect(asked.filter((call) => !call.summary).map((call) => call.by)).toEqual(["anthropic"]);
    // What the summary after the reply is planned with is the same model.
    expect(result.compaction.summaryModel).toBe("gemini-3.8-flash");
    // Metered under the profile that answered — its price and billing are that profile's — as a compaction.
    expect(recorded).toEqual([
      expect.objectContaining({ agentId: "nouva", provider: "nougate", model: "gemini-3.8-flash", purpose: "compaction", sessionId: "s1", turnId: "turn_1" }),
    ]);
  });

  test("with no runner's route, a summary_model that cannot answer hands the summary to the turn's own model", async () => {
    const asked: string[] = [];
    const provider = {
      kind: "openai",
      baseUrl: "https://anthropic.test/v1",
      async chat(params: ChatParams): Promise<ChatResponse> {
        asked.push(params.model);
        if (params.model === "gone-summary-model") throw new LLMError("404 Not Found: model_not_found", 404);
        return { text: params.temperature === 0 ? "- what was decided" : "answered", toolCalls: [], stopReason: "stop", usage: { inputTokens: 10, outputTokens: 2 }, model: params.model };
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent();

    const result = await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 2, summaryModel: "gone-summary-model", compactAtRatio: 0.05, compactAtTokens: 1_000, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    }).run({
      agent,
      provider,
      toolset: emptyToolset,
      history: longHistory(),
      userMessage: { role: "user", content: "and now?", timestamp: 99 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    expect(asked).toEqual(["gone-summary-model", agent.config.llm.model, agent.config.llm.model]);
    expect(result.text).toBe("answered");
  });
});

/**
 * Through the daemon's own pipeline: the compaction before an answer, the one after it — the one that usually runs —
 * and `/compact`, each with `[memory] pass_model` set. Two profiles on one scripted transport, told apart by the
 * model each request names and by the profile each usage row is charged to.
 */
describe("a conversation's compaction, through the pipeline", () => {
  let bench: Bench | undefined;
  afterEach(() => bench?.dispose());

  /** The bench with a second profile, `cheap`, named as the pass's — and usage recorded, as a daemon records it. */
  async function withPassModel(options: { turns: Parameters<typeof scriptedOpenAI>[0]; agentToml?: string; context: Partial<GlobalConfig["llm"]["context"]> }): Promise<Bench> {
    let usage: UsageStore | undefined;
    bench = await pipelineBench({
      turns: options.turns,
      ...(options.agentToml ? { agentToml: options.agentToml } : {}),
      configure: (config, db) => {
        config.providers.cheap = { ...config.providers.test! };
        config.memory.passProvider = "cheap";
        config.memory.passModel = "cheap-model";
        Object.assign(config.llm.context, options.context);
        usage = new UsageStore(db);
      },
      deps: () => (usage ? { usage } : {}),
    });
    bench.pipeline.attach();
    return bench;
  }

  const charged = (b: Bench) =>
    b.db
      .prepare<{ provider: string; purpose: string | null }>("SELECT provider, purpose FROM llm_usage ORDER BY timestamp, rowid")
      .all()
      .map((row) => `${row.provider}:${row.purpose}`);
  const models = (b: Bench) => (b.requests as { model: string }[]).map((request) => request.model);

  test("the compaction before the answer is asked of the pass's model, and charged to its profile", async () => {
    const b = await withPassModel({ turns: [{ text: "Headline: the earlier part\nWhat was decided." }, { text: "answered" }], context: { truncationStrategy: "summary", compactAtTokens: 16_000 } });
    const long = Array.from({ length: 30 }, (_, n) => [
      { role: "user" as const, content: `question ${n} ${"x".repeat(2_400)}`, timestamp: n },
      { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_400)}`, timestamp: n },
    ]).flat();
    const first = envelope({ text: "and now?", timestamp: Date.now() });
    b.sessions.save({ agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId }, long, 40_000);

    b.gateway.receive(first);
    await b.pipeline.idle();

    const summaries = b.requests.length - 1;
    expect(summaries).toBeGreaterThan(0);
    expect(models(b)).toEqual([...Array(summaries).fill("cheap-model"), "test-model"]);
    expect(charged(b)).toEqual([...Array(summaries).fill("cheap:compaction"), "test:turn"]);
  });

  test("and so is the compaction after the reply, the one that usually runs", async () => {
    // The provider counts four tokens for each the estimator does (the scale's ceiling), so history the pass before the
    // turn leaves alone is past the line once the turn has measured it, and is compacted after the reply.
    const b = await withPassModel({
      turns: [{ text: "answered", promptTokens: 1_000_000 }, { text: "Headline: the earlier part\nWhat was decided." }],
      agentToml: '[llm]\nprovider = "test"\ncontext_window = 40000\n',
      context: { truncationStrategy: "summary", compactAtRatio: 0.3, preserveRecentTurns: 1 },
    });
    const history = Array.from({ length: 8 }, (_, n) => [
      { role: "user" as const, content: `question ${n} ${"x".repeat(2_000)}`, timestamp: n },
      { role: "assistant" as const, content: `answer ${n}`, timestamp: n },
    ]).flat();
    const first = envelope({ text: "and now?", timestamp: Date.now() });
    const key = { agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId };
    b.sessions.save(key, history, 4_000);

    b.gateway.receive(first);
    await b.pipeline.idle();

    expect(models(b)).toEqual(["test-model", "cheap-model"]);
    expect(JSON.stringify(b.sessions.load(key).messages)).toContain("What was decided.");
    expect(charged(b)).toEqual(["test:turn", "cheap:compaction"]);
  });

  test("`/compact` asks it too, as a turn's compaction would", async () => {
    const b = await withPassModel({ turns: [{ text: "one" }, { text: "two" }, { text: "SUMMARY OF EARLIER" }], context: { preserveRecentTurns: 1 } });
    for (const [i, text] of ["first", "second"].entries()) {
      b.gateway.receive(envelope({ id: `m${i}`, text: `${text} ${"the details of the question, at length. ".repeat(20)}`, timestamp: Date.now() }));
      await b.pipeline.idle();
    }

    b.gateway.receive(envelope({ id: "mc", text: "/compact", timestamp: Date.now() }));
    await b.pipeline.idle();

    expect(b.gateway.lastText()).toContain("Compacted");
    expect(models(b)).toEqual(["test-model", "test-model", "cheap-model"]);
    expect(charged(b)).toEqual(["test:turn", "test:turn", "cheap:compaction"]);
  });
});

describe("the window a summary is sized for", () => {
  test("the smaller of the helper's and the agent's own — the agent's own model may be the one that answers", () => {
    // A Gemini helper (a million) that falls back to a Claude agent (200k): stretches sized for the helper would not fit.
    expect(summarizerWindowFor("gemini-3.8-flash-high", "claude-sonnet-5-5", 200_000)).toBe(200_000);
    expect(summarizerWindowFor("claude-sonnet-5-5", "gemini-3.8-flash-high", 1_000_000)).toBe(200_000);
    expect(summarizerWindowFor("claude-sonnet-5-5", "claude-sonnet-5-5", 180_000)).toBe(180_000);
  });
});
