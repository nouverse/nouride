/**
 * How long a provider is given to come back, for a turn that can now make two hundred calls over an hour.
 *
 * Three attempts in a second and a half suited a chat reply. One rate limit or one gateway restart anywhere
 * in a long turn ended all of it, so the backoff is half a minute, a wait the provider names is honoured, a
 * quota is not waited out, a provider that does not answer at all is not tried six times, and a turn stopped
 * during a wait stops at once.
 */

import { describe, expect, test } from "bun:test";
import { LLMError } from "@nouride/shared";
import { postJson, retryAfterMs } from "../src/http.ts";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, sseResponse } from "./helpers.ts";
import { sleep } from "./wait.ts";

function refusal(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: "slow down" } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("the backoff", () => {
  test("waits 1, 2, 4, 8 and 16 seconds, and the attempt after a rate limit lifts gets through", async () => {
    const slept: number[] = [];
    const fetcher = fakeFetch((_req, attempt) => (attempt < 5 ? refusal(429) : new Response("{}", { status: 200 })));
    const res = await postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: fetcher.fn, sleep: async (ms) => void slept.push(ms) });
    expect(res.status).toBe(200);
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  test("honours a longer wait the provider names", async () => {
    const slept: number[] = [];
    const fetcher = fakeFetch((_req, attempt) => (attempt === 0 ? refusal(429, { "retry-after": "20" }) : new Response("{}", { status: 200 })));
    await postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: fetcher.fn, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([20_000]);
  });

  test("waits a minute and a half in all, however often a provider asks for a minute", async () => {
    const slept: number[] = [];
    const fetcher = fakeFetch(refusal(429, { "retry-after": "60" }));
    await expect(postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: fetcher.fn, sleep: async (ms) => void slept.push(ms) })).rejects.toThrow(/429/);
    expect(slept).toEqual([60_000]);
    expect(fetcher.requests).toHaveLength(2);
  });

  test("does not wait out a quota — a wait past a minute fails now, for the turn to be taken up later", async () => {
    const fetcher = fakeFetch(refusal(429, { "retry-after": "3600" }));
    await expect(postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: fetcher.fn, sleep: async () => {} })).rejects.toThrow(/429/);
    expect(fetcher.requests).toHaveLength(1);
  });

  test("tries a provider that never answers twice, not six times — each try can take two minutes", async () => {
    let attempts = 0;
    const hanging = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    await expect(postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: hanging, sleep: async () => {}, timeoutMs: 20 })).rejects.toThrow(/no response within 20ms/);
    expect(attempts).toBe(2);
  });

  test("a provider not reached, or silent past the deadline, is classified a passing failure — what a fallback answers", async () => {
    const refused = (async () => {
      throw new TypeError("ECONNREFUSED: Unable to connect");
    }) as unknown as typeof fetch;
    const hanging = (async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    for (const fetchImpl of [refused, hanging]) {
      const failed = await postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl, sleep: async () => {}, timeoutMs: 20, maxAttempts: 2 }).catch((err: unknown) => err);
      expect(failed).toBeInstanceOf(LLMError);
      expect((failed as LLMError).failure).toMatchObject({ class: "transient", action: "retry", alertOperator: false });
    }
  });

  test("does not retry a URL that is not a URL — configuration, not a blip", async () => {
    let attempts = 0;
    const failing = (async () => {
      attempts += 1;
      throw Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" });
    }) as unknown as typeof fetch;
    await expect(postJson("x/chat/completions", {}, {}, undefined, { fetchImpl: failing, sleep: async () => {} })).rejects.toThrow(/not valid/);
    expect(attempts).toBe(1);
  });

  test("stops waiting the moment the turn is stopped", async () => {
    const controller = new AbortController();
    const fetcher = fakeFetch(refusal(503));
    const started = Date.now();
    const pending = postJson("https://p.test/v1/x", {}, {}, controller.signal, { fetchImpl: fetcher.fn, baseDelayMs: 60_000 });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetcher.requests).toHaveLength(1);
  });
});

describe("saying so while it waits", () => {
  test("each wait is announced before it starts — the attempt coming, how long, and what went wrong", async () => {
    const said: string[] = [];
    const busy = () => new Response(JSON.stringify({ error: { message: "the server is busy" } }), { status: 503, headers: { "content-type": "application/json" } });
    const fetcher = fakeFetch((_req, attempt) => (attempt === 0 ? refusal(429, { "retry-after": "3" }) : attempt === 1 ? busy() : new Response("{}", { status: 200 })));
    await postJson("https://p.test/v1/x", {}, {}, undefined, {
      fetchImpl: fetcher.fn,
      sleep: async (ms) => void said.push(`slept ${ms}`),
      onRetry: (info) => void said.push(JSON.stringify(info)),
    });
    expect(said).toEqual([
      JSON.stringify({ attempt: 2, maxAttempts: 6, delayMs: 3_000, status: 429, failure: "rate_limit" }),
      "slept 3000",
      JSON.stringify({ attempt: 3, maxAttempts: 6, delayMs: 2_000, status: 503, failure: "overloaded" }),
      "slept 2000",
    ]);
  });

  test("a provider that did not answer in time, or could not be reached, is said as such — no status, no body", async () => {
    const failures: unknown[] = [];
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.1");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: flaky, sleep: async () => {}, onRetry: (info) => void failures.push(info) });
    expect(failures).toEqual([{ attempt: 2, maxAttempts: 6, delayMs: 1_000, failure: "network" }]);
  });

  test("a watcher that throws does not stop the retry", async () => {
    const fetcher = fakeFetch((_req, attempt) => (attempt === 0 ? refusal(429) : new Response("{}", { status: 200 })));
    const res = await postJson("https://p.test/v1/x", {}, {}, undefined, { fetchImpl: fetcher.fn, sleep: async () => {}, onRetry: () => { throw new Error("broken"); } });
    expect(res.status).toBe(200);
  });

  test("a chat call hands its onRetry to the request it makes", async () => {
    const seen: number[] = [];
    const fetcher = fakeFetch((_req, attempt) => (attempt === 0 ? refusal(429) : jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })));
    const provider = new OpenAIProvider({ baseUrl: "https://p.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: async () => {} } });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false, onRetry: (info) => void seen.push(info.attempt) });
    expect(seen).toEqual([2]);
    const anthropic = new AnthropicProvider({ baseUrl: "https://a.test/v1", apiKey: "k", http: { fetchImpl: fakeFetch((_req, attempt) => (attempt === 0 ? refusal(529) : jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }))).fn, sleep: async () => {} } });
    await anthropic.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false, onRetry: (info) => void seen.push(info.attempt) });
    expect(seen).toEqual([2, 2]);
  });
});

describe("retryAfterMs", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  test("reads milliseconds, seconds, and a date", () => {
    expect(retryAfterMs(headers({ "retry-after-ms": "1500" }))).toBe(1_500);
    expect(retryAfterMs(headers({ "retry-after": "7" }))).toBe(7_000);
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(retryAfterMs(headers({ "retry-after": "Tue, 13 Oct 2026 00:00:30 GMT" }), now)).toBe(30_000);
  });

  test("is nothing for nothing usable", () => {
    expect(retryAfterMs(headers({}))).toBe(0);
    expect(retryAfterMs(headers({ "retry-after": "soon" }))).toBe(0);
  });
});

/**
 * What a call took, carried on the usage it reports. The retries above happened, and nothing downstream knew:
 * a turn that waited half a minute on a provider's 429s looked like a slow model.
 */
describe("what a call took, on its usage", () => {
  const params = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
  /** Two refusals, then `answer` — each backoff a real 40 ms, so the time measured is the waits' and not the CPU's. */
  const twiceRefused = (answer: () => Response) => fakeFetch((_req, attempt) => (attempt < 2 ? refusal(503) : answer()));
  const clocked = (fetchImpl: typeof fetch) => ({ fetchImpl, sleep: () => sleep(40) });
  const usageOf = async (chunks: AsyncIterable<{ type: string; usage?: unknown }>) => {
    for await (const chunk of chunks) if (chunk.type === "usage") return chunk.usage as { attempts?: number; latencyMs?: number };
    return undefined;
  };

  test("OpenAI: the attempts and the time, retries and their waits included — answered or streamed", async () => {
    const answered = new OpenAIProvider({ baseUrl: "https://p.test/v1", apiKey: "k", http: clocked(twiceRefused(() => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })).fn) });
    const usage = (await answered.chat(params)).usage;
    expect(usage.attempts).toBe(3);
    expect(usage.latencyMs).toBeGreaterThanOrEqual(80);

    const streamed = new OpenAIProvider({ baseUrl: "https://p.test/v1", apiKey: "k", http: clocked(twiceRefused(() => sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n', "data: [DONE]\n\n"])).fn) });
    expect(await usageOf(streamed.stream(params))).toMatchObject({ attempts: 3 });
  });

  test("Anthropic: the same, by the same means", async () => {
    const answered = new AnthropicProvider({ baseUrl: "https://a.test/v1", apiKey: "k", http: clocked(twiceRefused(() => jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } })).fn) });
    expect((await answered.chat(params)).usage).toMatchObject({ attempts: 3 });

    const streamed = new AnthropicProvider({ baseUrl: "https://a.test/v1", apiKey: "k", http: clocked(twiceRefused(() => sseResponse(['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n', 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n'])).fn) });
    const usage = await usageOf(streamed.stream(params));
    expect(usage?.attempts).toBe(3);
    expect(usage?.latencyMs).toBeGreaterThanOrEqual(80);
  });

  test("a call that got through first time says so", async () => {
    const provider = new OpenAIProvider({ baseUrl: "https://p.test/v1", apiKey: "k", http: { fetchImpl: fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })).fn } });
    expect((await provider.chat(params)).usage.attempts).toBe(1);
  });
});
