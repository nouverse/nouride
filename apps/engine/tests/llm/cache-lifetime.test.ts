/**
 * How long a provider keeps a cached prompt is the provider's, said by its profile.
 *
 * Every conversation idle for under an hour was taken to still have a warm cache, so old tool output stayed in its
 * history. Anthropic's own API keeps a cache five minutes: between five minutes and an hour idle the cache was gone
 * and the free moment to clear was not used. The lifetime is now a profile's (`cache_minutes`), with the known
 * endpoints' table giving it for an endpoint whose vendor states one, and an hour for one that does not say.
 */

import { describe, expect, test } from "bun:test";
import { SecretStore } from "@nouride/secrets";
import type { ChatMessage, ChatParams, LLMProvider } from "@nouride/shared";
import { parseConfig } from "@/modules/config/global/index.ts";
import { ASSUMED_CACHE_LIFETIME_MS, CacheBreaks } from "@/modules/llm/cache-breaks.ts";
import { TRIMMED_TOOL_PREFIX } from "@/modules/llm/context.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent, tempDir } from "../helpers.ts";

const MINUTE = 60_000;

const profiles = (extra: Record<string, Record<string, unknown>> = {}) => ({
  providers: {
    anthropic: { kind: "anthropic", base_url: "https://api.anthropic.com/v1", api_key: "anthropic_api_key", ...extra.anthropic },
    openai: { kind: "openai", base_url: "https://api.openai.com/v1", api_key: "openai_api_key", ...extra.openai },
    openrouter: { kind: "openai", base_url: "https://openrouter.ai/api/v1", api_key: "openrouter_api_key", ...extra.openrouter },
    ollama: { kind: "openai", base_url: "http://127.0.0.1:11434/v1", api_key: "ollama_api_key", ...extra.ollama },
    nougate: { kind: "anthropic", base_url: "http://127.0.0.1:18256/anthropic/v1", api_key: "nougate_api_key", ...extra.nougate },
  },
});

describe("[providers.<name>] cache_minutes", () => {
  test("left out: five minutes on Anthropic's own API, not known anywhere else", () => {
    const { providers } = parseConfig(profiles());
    expect(providers.anthropic?.cacheMinutes).toBe(5);
    // However the address is written: a host's case and a trailing slash change nothing.
    expect(parseConfig(profiles({ anthropic: { base_url: "https://API.anthropic.com/v1/" } })).providers.anthropic?.cacheMinutes).toBe(5);
    expect(providers.openai?.cacheMinutes).toBeUndefined();
    expect(providers.openrouter?.cacheMinutes).toBeUndefined();
    expect(providers.ollama?.cacheMinutes).toBeUndefined();
    // The Anthropic wire on another address is another server: its lifetime is its own.
    expect(providers.nougate?.cacheMinutes).toBeUndefined();
  });

  test("a profile's own key wins over the table, and says it for an endpoint the table does not know", () => {
    const { providers } = parseConfig(profiles({ anthropic: { cache_minutes: 60 }, nougate: { cache_minutes: 5 }, ollama: { cache_minutes: 0 } }));
    expect(providers.anthropic?.cacheMinutes).toBe(60);
    expect(providers.nougate?.cacheMinutes).toBe(5);
    // None at all: an endpoint that caches nothing.
    expect(providers.ollama?.cacheMinutes).toBe(0);
  });

  test("refused by its path when it is not a whole number of minutes", () => {
    for (const bad of [-1, 2.5, "5", true]) {
      expect(() => parseConfig(profiles({ openai: { cache_minutes: bad } }))).toThrow("[providers.openai] cache_minutes must be a whole number of minutes, 0 or more");
    }
  });

  test("the client the registry builds declares it, as milliseconds; one whose profile does not know declares nothing", async () => {
    const config = parseConfig(profiles({ openrouter: { cache_minutes: 30 } }));
    const secrets = await SecretStore.open(tempDir("secrets"), { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", OPENROUTER_API_KEY: "k" });
    // With the mask the daemon puts in front of every client: what a turn is handed.
    const providers = new ProviderRegistry(config.providers, secrets, {}, () => ({}));
    expect(providers.get("anthropic").cacheLifetimeMs).toBe(5 * MINUTE);
    expect(providers.get("openrouter").cacheLifetimeMs).toBe(30 * MINUTE);
    expect(providers.get("openai").cacheLifetimeMs).toBeUndefined();
  });
});

describe("whether the cache was lost, by the endpoint's lifetime", () => {
  const lostAfter = (idleMs: number, lifetimeMs: number) => new CacheBreaks().lost("ses", "prefix", 1_000_000, 1_000_000 + idleMs, lifetimeMs);

  test("five minutes: warm a second before, gone at five minutes", () => {
    expect(lostAfter(5 * MINUTE - 1_000, 5 * MINUTE)).toBe(false);
    expect(lostAfter(5 * MINUTE, 5 * MINUTE)).toBe(true);
    expect(lostAfter(20 * MINUTE, 5 * MINUTE)).toBe(true);
  });

  test("an hour: twenty minutes idle is still warm, gone at the hour", () => {
    expect(lostAfter(20 * MINUTE, 60 * MINUTE)).toBe(false);
    expect(lostAfter(60 * MINUTE - 1_000, 60 * MINUTE)).toBe(false);
    expect(lostAfter(60 * MINUTE, 60 * MINUTE)).toBe(true);
  });

  test("an endpoint that does not say is taken for an hour", () => {
    expect(ASSUMED_CACHE_LIFETIME_MS).toBe(60 * MINUTE);
  });
});

describe("at a turn's start, through the executor", () => {
  const text = (message: ChatMessage) => (typeof message.content === "string" ? message.content : "");

  /** Four earlier turns with tool output, the last message `idleMs` ago. */
  const history = (idleMs: number): ChatMessage[] => {
    const at = Date.now() - idleMs;
    return Array.from({ length: 4 }, (_, n): ChatMessage[] => [
      { role: "user", content: `question ${n}`, timestamp: at },
      { role: "assistant", content: "", toolCalls: [{ id: `call_${n}`, name: "exec", arguments: { command: `cat log-${n}` } }], timestamp: at },
      { role: "tool", toolCallId: `call_${n}`, content: `output ${n}: ${"x".repeat(2_000)}`, timestamp: at },
      { role: "assistant", content: `answer ${n}`, timestamp: at },
    ]).flat();
  };

  /** The tool results the turn's first request carried, on an endpoint that keeps a cache `cacheLifetimeMs` (or does not say). */
  async function sentAfter(idleMs: number, sessionId: string, cacheLifetimeMs?: number): Promise<string[]> {
    const asked: ChatParams[] = [];
    const provider = {
      kind: "anthropic",
      baseUrl: "https://gw.test/v1",
      ...(cacheLifetimeMs === undefined ? {} : { cacheLifetimeMs }),
      chat: async (params: ChatParams) => (asked.push(params), { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }),
      stream() {
        throw new Error("streaming is off here");
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent();
    // A window and a compaction line far above this history: what clears here is this step, not compaction.
    agent.config.llm = { provider: "gw", model: "m", maxTokens: 128, temperature: 0.7, contextWindow: 1_000_000, compactAtTokens: 900_000 };
    const toolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };
    await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 2, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    }).run({
      agent, provider, toolset, history: history(idleMs),
      userMessage: { role: "user", content: "and now?", timestamp: Date.now() },
      gateway: "telegram", gatewayId: "telegram:main", chatId: "814", chatType: "dm", sessionId, senderId: "814",
    });
    return asked[0]!.messages.filter((message) => message.role === "tool").map(text);
  }

  const cleared = (sent: string[]) => sent.map((one) => one.startsWith(TRIMMED_TOOL_PREFIX));

  test("an endpoint that keeps a cache five minutes: twenty minutes idle, the old output goes; three, it stays", async () => {
    expect(cleared(await sentAfter(20 * MINUTE, "ses_5m_idle", 5 * MINUTE))).toEqual([true, true, false, false]);
    expect(cleared(await sentAfter(3 * MINUTE, "ses_5m_warm", 5 * MINUTE))).toEqual([false, false, false, false]);
  });

  test("one that keeps it an hour, or does not say: twenty minutes idle stays; past the hour it goes", async () => {
    expect(cleared(await sentAfter(20 * MINUTE, "ses_1h_warm", 60 * MINUTE))).toEqual([false, false, false, false]);
    expect(cleared(await sentAfter(20 * MINUTE, "ses_unknown_warm"))).toEqual([false, false, false, false]);
    expect(cleared(await sentAfter(61 * MINUTE, "ses_1h_idle", 60 * MINUTE))).toEqual([true, true, false, false]);
    expect(cleared(await sentAfter(61 * MINUTE, "ses_unknown_idle"))).toEqual([true, true, false, false]);
  });
});
