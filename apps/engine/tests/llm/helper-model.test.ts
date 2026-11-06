/**
 * A helper model that cannot answer, and the agent's own asked instead (`llm/helper-model.ts`).
 *
 * The box, 2026-10-21: `[memory] pass_model` went away — nougate answered `404 No account has access`, then `429 …
 * insufficient_quota` — and every compaction failed from then on. A Telegram conversation was never compacted again:
 * ~180k tokens a call against a 160k limit. The helper's failures here come from a real client in front of a gateway
 * that answers with them, so the classification is the one `postJson` makes live.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { addLogSink, LLMError, type ChatMessage, type ChatParams, type ChatResponse, type LLMProvider, type LogEntry } from "@nouride/shared";
import { createProvider } from "@nouride/llm";
import { HELPER_ANSWERED, helperUnavailable, orOwnModel } from "@/modules/llm/helper-model.ts";
import { summarizerFor } from "@/modules/llm/summarizer.ts";
import { compactHistory, resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import type { UsageRecord } from "@/modules/llm/usage.store.ts";

const said: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "llm.helper" && said.push(entry)));

/** A real client in front of a gateway that answers every request with `status` and `body`; the models asked go into `asked`. */
function gateway(status: number, body: string, asked: string[], headers: Record<string, string> = {}): LLMProvider {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { model: string }).model);
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return createProvider({ kind: "openai", baseUrl: "https://nougate.test/v1", apiKey: "k", http: { fetchImpl, sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1 } });
}

/** A gateway that never answers: each attempt runs out its deadline. */
function silent(asked: string[]): LLMProvider {
  const fetchImpl = ((_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { model: string }).model);
    return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as unknown as typeof fetch;
  return createProvider({ kind: "openai", baseUrl: "https://nougate.test/v1", apiKey: "k", http: { fetchImpl, sleep: async () => {}, timeoutMs: 5 } });
}

/** The agent's own model, answering. */
function answering(asked: string[]): LLMProvider {
  return {
    kind: "anthropic",
    baseUrl: "https://anthropic.test",
    async chat(params: ChatParams): Promise<ChatResponse> {
      asked.push(params.model);
      return { text: "Headline: the earlier part\nWhat was decided.", toolCalls: [], stopReason: "stop", usage: { inputTokens: 10, outputTokens: 2 }, model: params.model };
    },
    async *stream() {
      throw new Error("not used");
    },
  } as unknown as LLMProvider;
}

const NO_ACCESS = '{"error":{"message":"No account has access to \\"gemini-3.7-flash\\""}}';
const QUOTA = '{"error":{"message":"Quota Exhausted","type":"insufficient_quota"}}';
const PASS = { llm: { context: { summaryModel: undefined }, defaults: { provider: "anthropic" } }, memory: { passProvider: "nougate", passModel: "gemini-3.7-flash" } };
const NONE = { llm: { context: { summaryModel: undefined }, defaults: { provider: "anthropic" } }, memory: { passProvider: "", passModel: "" } };

/** A turn's summarizer as the pipeline builds it, on profiles `nougate` (the pass's) and `anthropic` (the agent's). */
function summarizer(helper: LLMProvider, own: LLMProvider, config: typeof PASS = PASS) {
  const recorded: UsageRecord[] = [];
  const profiles: Record<string, LLMProvider> = { nougate: helper, anthropic: own };
  const route = summarizerFor(
    { config, providers: { get: (name: string) => profiles[name]! }, usage: { record: (row: UsageRecord) => void recorded.push(row) } },
    { agentId: "nouva", profile: "anthropic", sessionId: "s1", tiers: { provider: "anthropic", model: "claude-opus-5-5" } },
  )("claude-opus-5-5");
  return { ...route, recorded };
}

function history(turns: number): ChatMessage[] {
  return Array.from({ length: turns }, (_, n) => [
    { role: "user" as const, content: `question ${n} ${"x".repeat(2_000)}`, timestamp: n * 1000 },
    { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_000)}`, timestamp: n * 1000 + 1 },
  ]).flat();
}

const compact = (route: { provider: LLMProvider; model: string }, key = "conversation") =>
  compactHistory(history(10), { provider: route.provider, model: route.model, maxTokens: 10_000, limit: 10_000, key });

beforeEach(() => {
  resetCompactionBreaker();
  said.length = 0;
});

describe("a compaction whose helper model cannot answer", () => {
  test("a 404 from the pass's model: the summary is asked of the agent's own, and charged to its profile", async () => {
    const helperAsked: string[] = [];
    const ownAsked: string[] = [];
    const route = summarizer(gateway(404, NO_ACCESS, helperAsked), answering(ownAsked));

    const result = await compact(route);

    expect(result.compacted).toBe(true);
    expect(result.failed).toBeUndefined();
    // Not retried — a model that is not served will not be on the next attempt either — and then the agent's own.
    expect(helperAsked).toEqual(["gemini-3.7-flash"]);
    expect(ownAsked).toEqual(["claude-opus-5-5"]);
    expect(route.recorded).toEqual([expect.objectContaining({ provider: "anthropic", model: "claude-opus-5-5", purpose: "compaction" })]);
    expect(said.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^helper model nougate\/gemini-3\.7-flash unavailable \(404 .*No account has access.*\), so used the agent's own model anthropic\/claude-opus-5-5 for compaction$/),
    ]);
  });

  test("a 429 that says insufficient_quota: the same", async () => {
    const ownAsked: string[] = [];
    const result = await compact(summarizer(gateway(429, QUOTA, []), answering(ownAsked)));
    expect(result.compacted).toBe(true);
    expect(ownAsked).toEqual(["claude-opus-5-5"]);
  });

  test("a 500 is the provider's to retry, not a reason to ask another model", async () => {
    const helperAsked: string[] = [];
    const ownAsked: string[] = [];
    const result = await compact(summarizer(gateway(500, '{"error":{"message":"internal error"}}', helperAsked), answering(ownAsked)));
    expect(result.failed).toBe(true);
    expect(helperAsked.length).toBe(3);
    expect(ownAsked).toEqual([]);
    expect(said).toEqual([]);
  });

  test("so is a helper that never answers", async () => {
    const helperAsked: string[] = [];
    const ownAsked: string[] = [];
    const result = await compact(summarizer(silent(helperAsked), answering(ownAsked)));
    expect(result.failed).toBe(true);
    expect(helperAsked.length).toBe(2);
    expect(ownAsked).toEqual([]);
  });

  test("and a plain rate limit with a short wait", async () => {
    const ownAsked: string[] = [];
    const result = await compact(summarizer(gateway(429, '{"error":{"message":"Rate limit reached"}}', [], { "retry-after": "1" }), answering(ownAsked)));
    expect(result.failed).toBe(true);
    expect(ownAsked).toEqual([]);
  });

  test("the agent's own model is the route: nothing to fall back to, asked once", async () => {
    const asked: string[] = [];
    const own = gateway(404, NO_ACCESS, asked);
    const result = await compact(summarizer(own, own, NONE));
    expect(result.failed).toBe(true);
    expect(asked).toEqual(["claude-opus-5-5"]);
    expect(said).toEqual([]);
  });

  test("a fallback that answers is a compaction that worked: the breaker never pauses the conversation", async () => {
    for (let n = 0; n < 4; n += 1) {
      const result = await compact(summarizer(gateway(404, NO_ACCESS, []), answering([])));
      expect(result.paused).toBeUndefined();
      expect(result.compacted).toBe(true);
    }
  });
});

describe("the fallback", () => {
  const gone = (name: string) => ({ profile: "nougate", model: name, provider: gateway(404, NO_ACCESS, []) });
  const own = (asked: string[]) => ({ profile: "anthropic", model: "claude-opus-5-5", provider: () => answering(asked) });
  const ask = (provider: LLMProvider, signal?: AbortSignal) =>
    provider.chat({ model: "x", messages: [{ role: "user", content: "hi", timestamp: 0 }], ...(signal ? { signal } : {}) });

  test("is said once an hour per helper model, however many calls it answers", async () => {
    let now = Date.UTC(2026, 9, 21, 14, 0);
    const provider = orOwnModel(gone("hourly-model"), own([]), "memory pass", () => now);
    await ask(provider);
    now += 30 * 60_000;
    await ask(provider);
    expect(said).toHaveLength(1);
    now += 31 * 60_000;
    await ask(provider);
    expect(said).toHaveLength(2);
    expect(said[0]!.data).toMatchObject({ helper_profile: "nougate", helper_model: "hourly-model", job: "memory pass" });
  });

  test("is not taken for a call that was stopped", async () => {
    const ownAsked: string[] = [];
    const stopped = AbortSignal.abort();
    await expect(ask(orOwnModel(gone("stopped-model"), own(ownAsked), "compaction"), stopped)).rejects.toThrow();
    expect(ownAsked).toEqual([]);
  });

  test("a helper answering says so the first time in a process, and once after each fallback — no more", async () => {
    const state = { fails: false };
    const real = answering([]);
    const flaky: LLMProvider = {
      ...real,
      async chat(params) {
        if (state.fails) throw new LLMError(`404 Not Found: ${NO_ACCESS}`, 404);
        return await real.chat(params);
      },
    };
    const provider = orOwnModel({ profile: "nougate", model: "flaky-model", provider: flaky }, own([]), "memory pass");
    const lines = () => said.filter((entry) => entry.data?.helper_model === "flaky-model").map((entry) => (entry.message === HELPER_ANSWERED ? "answered" : "fell back"));

    await ask(provider);
    await ask(provider);
    expect(lines()).toEqual(["answered"]);
    state.fails = true;
    await ask(provider);
    state.fails = false;
    await ask(provider);
    await ask(provider);
    expect(lines()).toEqual(["answered", "fell back", "answered"]);
  });

  test("leaves the helper's own failure to be said when the agent's profile cannot be reached either", async () => {
    const provider = orOwnModel(gone("unreachable-model"), { profile: "anthropic", model: "m", provider: () => { throw new Error("no credential"); } }, "compaction");
    await expect(ask(provider)).rejects.toThrow(/No account has access/);
  });
});

describe("which failures mean the model cannot answer", () => {
  const error = (status: number | undefined, message: string) => new LLMError(message, status);

  test("not served, no access, out of quota or credit, refused", () => {
    expect(helperUnavailable(error(404, "404 Not Found: model gone"))).toContain("404");
    expect(helperUnavailable(error(403, "403 Forbidden"))).not.toBeNull();
    expect(helperUnavailable(error(402, "402 Payment Required"))).not.toBeNull();
    expect(helperUnavailable(error(429, "429 Too Many Requests: Quota Exhausted"))).not.toBeNull();
    expect(helperUnavailable(error(400, "400 Bad Request: unknown model gemini-9"))).not.toBeNull();
  });

  test("not a server error, a timeout, a dropped connection, a plain rate limit, a bad request or a stop", () => {
    expect(helperUnavailable(error(500, "500 Internal Server Error"))).toBeNull();
    expect(helperUnavailable(error(503, "503: model temporarily unavailable"))).toBeNull();
    expect(helperUnavailable(error(504, "no response within 120000ms"))).toBeNull();
    expect(helperUnavailable(error(429, "429 Too Many Requests: slow down"))).toBeNull();
    expect(helperUnavailable(error(400, "400 Bad Request: malformed tools"))).toBeNull();
    expect(helperUnavailable(error(undefined, "request aborted"))).toBeNull();
    expect(helperUnavailable(new Error("404"))).toBeNull();
  });
});
