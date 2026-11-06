/**
 * Every model call metered, through one seam (`modules/llm/metered.ts`), with what it was for and how it is billed.
 *
 * Seven call sites wrote their own `record`, and the ones that wrote none never reached `llm_usage`: a compaction —
 * on by default, often the largest request a long session makes — a reflection pass, an image described, a clip
 * transcribed. Both caps and every spend figure missed them. Here each path is driven with a provider that counts its
 * calls, and the rows have to add up to them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatParams, ChatResponse, LLMProvider, SessionKey, StreamChunk } from "@nouride/shared";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { CompactionPlan } from "@/modules/llm/executor/types.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { compactAfterReply } from "@/modules/pipeline/session-lifecycle.ts";
import { readImage } from "@/modules/attachments/vision.ts";
import { transcribe } from "@/modules/attachments/transcribe.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

let dir = "";
let db: SqliteDb;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-metering-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Row {
  agent_id: string;
  purpose: string | null;
  basis: string | null;
  turn_id: string | null;
  session_id: string | null;
  input_tokens: number;
  estimated: number | null;
  duration_ms: number | null;
  estimated_cost_usd: number | null;
  stop_reason: string | null;
}
const rows = () => db.prepare<Row>("SELECT * FROM llm_usage ORDER BY timestamp, rowid").all();

/** A provider that answers every chat with `text` and counts each call; usage 100 in, 10 out. */
function counting(text = "Headline: summary\nnotes") {
  const calls: ChatParams[] = [];
  const answer = (params: ChatParams): ChatResponse => {
    calls.push(params);
    return { text, toolCalls: [], stopReason: "stop", usage: { inputTokens: 100, outputTokens: 10 }, model: params.model };
  };
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    chat: async (params: ChatParams) => answer(params),
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const response = answer(params);
      yield { type: "text", delta: response.text };
      yield { type: "usage", usage: response.usage };
      yield { type: "done", stopReason: "stop" };
    },
    embed: async () => ({ vectors: [[1]], inputTokens: 7, estimated: true }),
  } as unknown as LLMProvider;
  return { provider, calls };
}

describe("the seam", () => {
  test("a wrapped provider reports each call as it is answered — chat, stream and embedding, an estimate said to be one", async () => {
    const reported: { input: number; model: string; estimated?: boolean }[] = [];
    const { provider } = counting();
    const wrapped = metered(provider, (usage, model) => void reported.push({ input: usage.inputTokens, model, ...(usage.estimated ? { estimated: true } : {}) }));
    await wrapped.chat({ model: "a", messages: [] });
    for await (const _chunk of wrapped.stream({ model: "b", messages: [] })) void _chunk;
    await wrapped.embed!({ model: "c", input: ["x"] });
    expect(reported).toEqual([
      { input: 100, model: "a" },
      { input: 100, model: "b" },
      { input: 7, model: "c", estimated: true },
    ]);
  });

  test("a meter writes the row with its purpose, and a call of another kind says its own", () => {
    const usage = new UsageStore(db);
    const charge = meter(usage, { agentId: "nouva", provider: "default", purpose: "turn", turnId: "t1", sessionId: "s1" });
    charge({ inputTokens: 1, outputTokens: 1 }, "m");
    charge({ inputTokens: 1, outputTokens: 1, estimated: true }, "m", "compaction");
    expect(rows().map(({ purpose, turn_id, estimated }) => ({ purpose, turn_id, estimated }))).toEqual([
      { purpose: "turn", turn_id: "t1", estimated: null },
      { purpose: "compaction", turn_id: "t1", estimated: 1 },
    ]);
  });

  test("…with why the call ended, as the provider said — and nothing where it said nothing, never a guessed `stop`", () => {
    const events = new EventStore(db, Date.now, { strict: true });
    db.prepare(
      "INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, status, prompt, started_at) VALUES ('t1', 's', 'nouva', 'telegram:main', 'c', 'running', 'hi', 1)",
    ).run();
    const charge = meter(new UsageStore(db, Date.now, events), { agentId: "nouva", provider: "default", purpose: "turn", turnId: "t1" });
    charge({ inputTokens: 1, outputTokens: 8_192, stopReason: "max_tokens" }, "m");
    charge({ inputTokens: 1, outputTokens: 1 }, "m");
    expect(rows().map((row) => row.stop_reason)).toEqual(["max_tokens", null]);
    // The stream's `usage` row says it too (1.4), and the strict store has held it to the contract.
    expect(events.list({ kinds: ["usage"] }).map((row) => row.data.stopReason)).toEqual(["max_tokens", undefined]);
  });

  test("the executor's own calls carry it from the provider to the row — streamed, the path the default config takes, and whole", async () => {
    for (const streaming of [true, false]) {
      db.prepare("DELETE FROM llm_usage").run();
      const provider = {
        kind: "openai",
        baseUrl: "https://fake.test/v1",
        chat: async (params: ChatParams): Promise<ChatResponse> => ({ text: "half", toolCalls: [], stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 9, stopReason: "max_tokens" }, model: params.model }),
        async *stream(): AsyncIterable<StreamChunk> {
          yield { type: "text", delta: "half" };
          yield { type: "usage", usage: { inputTokens: 5, outputTokens: 9, stopReason: "max_tokens" } };
          yield { type: "done", stopReason: "max_tokens", cutAtLimit: true };
        },
      } as unknown as LLMProvider;
      const charge = meter(new UsageStore(db), { agentId: "nouva", provider: "default", purpose: "turn", turnId: "t5" });
      const executor = new TurnExecutor({
        llm: {
          streaming: { enabled: streaming, typingIndicator: false, progressInChat: false },
          limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
          context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, summaryModel: undefined, compactAtRatio: 0.9, compactAtTokens: 1_000_000, preserveRecentToolResults: 3 },
        } as never,
        approvals: new AutoApprovalGate(),
        timezone: "UTC",
        commands: [],
        onUsage: (usage) => charge(usage, usage.model, usage.purpose),
      });
      await executor.run({
        agent: fakeAgent(),
        provider,
        toolset: { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] } as unknown as AgentToolset,
        history: [],
        userMessage: { role: "user", content: "write it all", timestamp: 1 },
        gateway: "telegram",
        gatewayId: "telegram:main",
        chatId: "chat-1",
        chatType: "dm",
        sessionId: "s1",
        senderId: "u1",
      });
      expect({ streaming, stopped: rows().map((row) => [row.purpose, row.stop_reason]) }).toEqual({ streaming, stopped: [["turn", "max_tokens"]] });
    }
  });
});

describe("a compaction", () => {
  const longHistory = (): ChatMessage[] =>
    Array.from({ length: 12 }, (_, i) => [
      { role: "user" as const, content: `question ${i} ${"x".repeat(2_000)}`, timestamp: i },
      { role: "assistant" as const, content: `answer ${i} ${"y".repeat(2_000)}`, timestamp: i },
    ]).flat();

  test("before a turn is metered by the turn, as a compaction — every call the provider got is one report", async () => {
    resetCompactionBreaker();
    const { provider, calls } = counting();
    const reported: (string | undefined)[] = [];
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 2, summaryModel: undefined, compactAtRatio: 0.05, compactAtTokens: 1_000, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onUsage: (usage) => void reported.push(usage.purpose),
    });
    await executor.run({
      agent: fakeAgent(),
      provider,
      toolset: { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] } as unknown as AgentToolset,
      history: longHistory(),
      userMessage: { role: "user", content: "and now?", timestamp: 99 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });
    expect(reported.length).toBe(calls.length);
    expect(reported.filter((purpose) => purpose === "compaction").length).toBeGreaterThan(0);
    expect(reported.at(-1)).toBeUndefined();
  });

  test("after a reply is charged to the turn, as a compaction — and a summary that came back empty was still paid for", async () => {
    resetCompactionBreaker();
    const usage = new UsageStore(db);
    const charge = meter(usage, { agentId: "nouva", provider: "default", purpose: "turn", turnId: "t9", sessionId: "s9" });
    const plan: CompactionPlan = { threshold: 6_000, limit: 6_000, totalLimit: 16_000, source: "agent", summaryModel: "m", summarizerWindow: 1_000_000 };
    const deps = { config: { llm: { context: { truncationStrategy: "summary" } }, daemon: { timezone: "UTC" } }, sessions: { save: () => {} } } as never;
    const key: SessionKey = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "c1" };
    const stored = longHistory();

    const { provider, calls } = counting();
    await compactAfterReply(deps, { key, sessionId: "s9", stored, plan, provider: metered(provider, (u, model) => charge(u, model, "compaction")) });
    expect(calls.length).toBeGreaterThan(0);
    expect(rows().map((row) => [row.purpose, row.turn_id])).toEqual(calls.map(() => ["compaction", "t9"]));

    resetCompactionBreaker();
    const empty = counting("   ");
    const before = rows().length;
    await compactAfterReply(deps, { key, sessionId: "s9", stored, plan, provider: metered(empty.provider, (u, model) => charge(u, model, "compaction")) });
    expect(rows().length - before).toBe(empty.calls.length);
  });
});

describe("an image read and a clip transcribed", () => {
  test("an image described is a row of its own, `vision`, under the turn that asked", async () => {
    const usage = new UsageStore(db);
    const { provider } = counting("A chart.");
    const deps = {
      config: { media: { readImages: true, maxImageBytes: 5_000_000, imageModel: "" } },
      registry: { get: () => fakeAgent() },
      providers: { get: () => provider },
      usage,
    } as never;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(await readImage(deps, { agentId: "nouva", bytes: png, mimeType: "image/png", turnId: "t2" })).toEqual({ description: "A chart." });
    expect(rows().map((row) => [row.purpose, row.turn_id, row.input_tokens])).toEqual([["vision", "t2", 100]]);
  });

  test("a clip transcribed is metered by its length, not by tokens nobody counted", async () => {
    const usage = new UsageStore(db);
    const clip = join(dir, "voice.ogg");
    writeFileSync(clip, "OggS");
    const result = await transcribe(clip, {
      providers: { endpointFor: () => ({ kind: "openai", baseUrl: "https://stt.test/v1", apiKey: "k" }) } as never,
      media: { transcribeProvider: "groq", transcribeModel: "whisper-large-v3" },
      fetchImpl: (async () => new Response(JSON.stringify({ text: "halo" }), { status: 200 })) as unknown as typeof fetch,
      record: meter(usage, { agentId: "nouva", provider: "groq", purpose: "transcription", durationMs: 12_000 }),
    });
    expect(result).toMatchObject({ ok: true, text: "halo" });
    expect(rows().map((row) => [row.purpose, row.duration_ms, row.input_tokens, row.basis])).toEqual([["transcription", 12_000, 0, "unpriced"]]);
  });
});

describe("how a call is billed", () => {
  test("a subscription profile's call costs nothing per token and says so — outside the dollar cap, inside the token cap", () => {
    const events = new EventStore(db, Date.now, { strict: true });
    db.prepare(
      "INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, status, prompt, started_at) VALUES ('t1', 's', 'nouva', 'telegram:main', 'c', 'running', 'hi', 1)",
    ).run();
    const usage = new UsageStore(db, Date.now, events, (provider) => (provider === "nougate" ? "included" : "metered"));
    usage.record({ agentId: "nouva", model: "claude-opus-4-6", provider: "nougate", turnId: "t1", purpose: "turn", inputTokens: 1_000_000, outputTokens: 0 });
    usage.record({ agentId: "nouva", model: "claude-opus-4-6", provider: "anthropic", turnId: "t1", purpose: "turn", inputTokens: 1_000_000, outputTokens: 0 });
    usage.record({ agentId: "nouva", model: "local-7b", provider: "anthropic", turnId: "t1", purpose: "turn", inputTokens: 10, outputTokens: 0 });

    expect(rows().map((row) => [row.basis, row.estimated_cost_usd])).toEqual([
      ["included", 0],
      ["list", 5],
      ["unpriced", null],
    ]);
    expect(usage.since(0)).toMatchObject({ usd: 5, includedRequests: 1, unpricedRequests: 1, inputTokens: 2_000_010 });
    expect(events.list({ kinds: ["usage"] }).map((row) => [row.data.basis, row.data.usd, row.data.priceAsOf])).toEqual([
      ["included", 0, undefined],
      ["list", 5, "2026-10-17"],
      ["unpriced", undefined, undefined],
    ]);
  });

  test("a coding CLI's prompt, through a turn's meter, is the CLI's — at no cost, out of both caps, and the stream says so (0.8.8)", () => {
    const events = new EventStore(db, Date.now, { strict: true });
    db.prepare(
      "INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, status, prompt, started_at) VALUES ('t1', 's', 'nix', 'telegram:main', 'c', 'running', 'hi', 1)",
    ).run();
    // The turn's meter, as `turn.ts` makes it: the agent's own profile — which a CLI's prompt went through none of.
    const charge = meter(new UsageStore(db, Date.now, events), { agentId: "nix", provider: "default", purpose: "turn", sessionId: "s", turnId: "t1" });
    charge({ inputTokens: 900_000, outputTokens: 4_000, cachedInputTokens: 800_000, cli: true }, "claude-opus-4-6", undefined, "claude-code");
    expect(rows().map((row) => [row.basis, row.estimated_cost_usd, row.purpose])).toEqual([["cli", 0, "turn"]]);
    expect(events.list({ kinds: ["usage"] }).map((row) => [row.data.basis, row.data.provider, row.data.usd])).toEqual([["cli", "claude-code", 0]]);
  });

  test("a session's last reply is the last of its turn's own calls, not a summary made after it", () => {
    let now = 1_000;
    const usage = new UsageStore(db, () => (now += 1));
    usage.record({ agentId: "nouva", model: "m", provider: "p", sessionId: "s1", purpose: "turn", inputTokens: 4_000, outputTokens: 1 });
    usage.record({ agentId: "nouva", model: "m", provider: "p", sessionId: "s1", purpose: "compaction", inputTokens: 90_000, outputTokens: 1 });
    expect(usage.forSession("s1", 0).lastInputTokens).toBe(4_000);
  });
});
