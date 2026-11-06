import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@nouride/shared";
import { contextWindowInfo, estimateCost } from "../src/index.ts";
import { priceFor } from "../src/cost.ts";
import { fillMissingUsage, normalizeModelId } from "../src/tokens.ts";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

/** The window size alone. */
const contextWindowFor = (model: string): number => contextWindowInfo(model).tokens;

describe("normalizeModelId", () => {
  test.each([
    ["antigravity:claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["anthropic/claude-3-5-sonnet", "claude-3-5-sonnet"],
    ["openrouter/anthropic/claude-3-5-sonnet", "claude-3-5-sonnet"],
    ["gpt-4o", "gpt-4o"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });
});

describe("prefixed models resolve to the real model's limits", () => {
  test("context window sees through a proxy prefix", () => {
    // Without this, an agent on Nougate's 200k Sonnet is capped at the 32k default and has
    // its history trimmed six times harder than it needs to be.
    expect(contextWindowFor("antigravity:claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("anthropic/claude-3-5-sonnet")).toBe(200_000);
  });

  test("price book sees through a proxy prefix", () => {
    expect(priceFor("antigravity:claude-sonnet-4-6")).toMatchObject({ input: 3, cachedInput: 0.3, output: 15 });
  });
});

describe("fillMissingUsage", () => {
  const request = {
    messages: [{ role: "user" as const, content: "a".repeat(400) }],
    system: "b".repeat(400),
  };

  test("passes reported usage through untouched", () => {
    const usage = fillMissingUsage({ inputTokens: 50, outputTokens: 10 }, request, "hi");
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 10, estimated: false });
  });

  test("estimates when the provider reports nothing", () => {
    // The real case this exists for: Nougate's OpenAI path omits `usage` entirely, and a
    // recorded zero would make the daily cost cap fail open.
    const usage = fillMissingUsage({ inputTokens: 0, outputTokens: 0 }, request, "c".repeat(40));
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBeGreaterThan(200);
    expect(usage.outputTokens).toBe(10);
  });

  test("fills only the missing half", () => {
    const usage = fillMissingUsage({ inputTokens: 0, outputTokens: 33 }, request, "text");
    expect(usage.outputTokens).toBe(33);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.estimated).toBe(true);
  });

  test("does not invent output tokens for an empty response", () => {
    const usage = fillMissingUsage({ inputTokens: 12, outputTokens: 0 }, request, "");
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 0, estimated: false });
  });

  test("a reply that is only tool calls produced output too — estimated from them, not counted as zero", () => {
    const args = JSON.stringify({ path: "notes.md", content: "x".repeat(2_000) });
    const usage = fillMissingUsage({ inputTokens: 12, outputTokens: 0 }, request, "", [{ name: "write", arguments: args }]);
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBeGreaterThan(400);
  });
});

describe("providers fill missing usage end to end", () => {
  test("OpenAI response with no usage field is estimated", async () => {
    // Exactly what Nougate returns: id, object, created, model, choices — and no usage.
    const fetcher = fakeFetch(
      jsonResponse({
        id: "x",
        model: "antigravity:claude-sonnet-4-6",
        choices: [{ message: { content: "Jakarta is the capital." }, finish_reason: "stop" }],
      }),
    );
    const provider = new OpenAIProvider({
      baseUrl: "https://nougate.example/openai/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    const res = await provider.chat({
      model: "antigravity:claude-sonnet-4-6",
      messages: [{ role: "user", content: "What is the capital of Indonesia?" }],
    });

    expect(res.usage.estimated).toBe(true);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  test("a streamed reply that is only a tool call, with no usage, is estimated from the call on both wires", async () => {
    const args = JSON.stringify({ command: "ls -la /srv/nouride", why: "y".repeat(800) });
    const openai = new OpenAIProvider({
      baseUrl: "https://nougate.example/openai/v1",
      apiKey: "k",
      http: {
        fetchImpl: fakeFetch(
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec", arguments: args } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        ).fn,
        sleep: noSleep,
      },
    });
    const anthropic = new AnthropicProvider({
      baseUrl: "https://nougate.example/anthropic/v1",
      apiKey: "k",
      http: {
        fetchImpl: fakeFetch(
          sseResponse([
            'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
            `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "exec", input: {} } })}\n\n`,
            `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } })}\n\n`,
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":0}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ]),
        ).fn,
        sleep: noSleep,
      },
    });
    for (const provider of [openai, anthropic]) {
      let usage: { outputTokens: number; estimated?: boolean } | undefined;
      for await (const chunk of provider.stream({ model: "m", messages: [{ role: "user", content: "list it" }] })) if (chunk.type === "usage") usage = chunk.usage;
      expect(usage?.estimated).toBe(true);
      expect(usage?.outputTokens).toBeGreaterThan(150);
    }
  });

  test("Anthropic stream reporting input_tokens 0 is estimated", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello there"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
      ]),
    );
    const provider = new AnthropicProvider({
      baseUrl: "https://nougate.example/anthropic/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    let usage: { inputTokens: number; outputTokens: number; estimated?: boolean } | undefined;
    for await (const chunk of provider.stream({
      model: "antigravity:claude-sonnet-4-6",
      messages: [{ role: "user", content: "say hi" }],
    })) {
      if (chunk.type === "usage") usage = chunk.usage;
    }

    expect(usage?.estimated).toBe(true);
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });
});

/**
 * Models a proxy serves that are not Claude, Gemini or GPT.
 *
 * Every one of these used to fall to the 32k default. That is not a small inaccuracy — the budget being
 * four times too small does not shorten a conversation, it makes the trimmer fire on every tool
 * iteration, so the agent loses the output of the call it is mid-way through using. A live install spent
 * an evening on exactly that, at a measured budget of 3,623 tokens against a million-token window.
 */
describe("long-context families a proxy renames", () => {
  test("they resolve to a real window rather than the conservative default", () => {
    for (const model of [
      "glm-4.6",
      "antigravity:glm-4.5",
      "kimi-k2",
      "deepseek-v3",
      "antigravity:deepseek-r1",
      "grok-4",
      "qwen3-235b",
      "llama-4-scout",
      "gpt-oss-120b",
      "mistral-large-2411",
    ]) {
      const info = contextWindowInfo(model);
      expect(info.known).toBe(true);
      expect(info.tokens).toBeGreaterThanOrEqual(128_000);
    }
  });
});

/**
 * A cache read is an input token the provider charges a tenth for.
 *
 * Pricing it as a full read is not a rounding error in the direction you would hope: the daily cap
 * trips early and starts refusing turns the budget could afford, and the operator sees an agent that
 * has stopped working for a reason no log explains.
 */
describe("prompt-cache reads are priced at a tenth — Sonnet 4.6's cached price", () => {
  const model = "claude-sonnet-4-6";

  test("a cached token costs a tenth of a fresh one", () => {
    const fresh = estimateCost(model, { inputTokens: 100_000, outputTokens: 0 });
    const allCached = estimateCost(model, {
      inputTokens: 100_000,
      outputTokens: 0,
      cachedInputTokens: 100_000,
    });

    expect(fresh.usd).toBeCloseTo(0.3, 6);
    expect(allCached.usd).toBeCloseTo(0.03, 6);
  });

  test("the cached count comes out of the input total rather than being added to it", () => {
    // Both providers report a cache read *inside* their input count. Adding it on top would bill the
    // same token twice and make our figure disagree with the invoice.
    const half = estimateCost(model, {
      inputTokens: 100_000,
      outputTokens: 0,
      cachedInputTokens: 50_000,
    });
    // 50k at $3/M + 50k at $0.30/M
    expect(half.usd).toBeCloseTo(0.15 + 0.015, 6);
  });

  test("silence is charged at full price, not assumed to be a hit", () => {
    // A provider that reports no cache field must not quietly get a discount: understating spend
    // against a cap is the failure this codebase already learned once, from usage reported as zero.
    const quiet = estimateCost(model, { inputTokens: 100_000, outputTokens: 0 });
    expect(quiet.usd).toBeCloseTo(0.3, 6);
  });

  test("a cached count larger than the input it came with cannot credit the budget", () => {
    // A proxy is free to report nonsense, and a negative billable count would subtract from spend.
    const nonsense = estimateCost(model, {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 999_999,
    });
    expect(nonsense.usd).toBeCloseTo((1_000 / 1_000_000) * 3 * 0.1, 6);
    expect(nonsense.usd).toBeGreaterThan(0);
  });

  test("a written token costs a quarter more than a fresh one", () => {
    // Caching is not free when nothing reads it back. Pricing a write at par would show a breakpoint
    // placed after per-request content — which writes every request and reads none of them — as a
    // saving rather than as the 25% surcharge it is.
    const written = estimateCost(model, {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
    });
    expect(written.usd).toBeCloseTo(0.3 * 1.25, 6);
  });

  test("a healthy loop bills reads cheap, the delta at a premium, and the tail at par", () => {
    const turn = estimateCost(model, {
      inputTokens: 60_000,
      outputTokens: 0,
      cachedInputTokens: 50_000,
      cacheCreationInputTokens: 8_000,
    });
    // 50k read + 8k written + 2k fresh.
    expect(turn.usd).toBeCloseTo(
      (50_000 / 1_000_000) * 3 * 0.1 + (8_000 / 1_000_000) * 3 * 1.25 + (2_000 / 1_000_000) * 3,
      6,
    );
  });

  test("counts that do not add up cannot drive the billable total negative", () => {
    // Clamped as a pair against the running remainder. Two independent clamps would each pass on
    // their own and still sum past the input, which credits the budget.
    const nonsense = estimateCost(model, {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 900,
    });
    // 900 read, 100 written, nothing fresh — never a negative remainder.
    expect(nonsense.usd).toBeCloseTo(
      (900 / 1_000_000) * 3 * 0.1 + (100 / 1_000_000) * 3 * 1.25,
      6,
    );
    expect(nonsense.usd).toBeGreaterThan(0);
  });

  test("an unpriced model stays unpriced, cache or no cache", () => {
    const unknown = estimateCost("antigravity:gemini-3.7-flash", {
      inputTokens: 10_000,
      outputTokens: 100,
      cachedInputTokens: 9_000,
    });
    expect(unknown).toEqual({ usd: 0, unpriced: true });
  });
});

/** What the provider actually says, parsed off the wire. */
describe("cache hits are read from the provider's own usage block", () => {
  test("OpenAI reports them under prompt_tokens_details", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      }),
    );
    const provider = new OpenAIProvider({
      baseUrl: "https://nougate.example/openai/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    const res = await provider.chat({
      model: "antigravity:claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.usage.cachedInputTokens).toBe(900);
    expect(res.usage.inputTokens).toBe(1_000);
  });

  test("Anthropic reports them as cache_read_input_tokens", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 900 },
      }),
    );
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    const res = await provider.chat({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.usage.cachedInputTokens).toBe(900);
    // 1000 + 900. Anthropic's `input_tokens` is the *uncached remainder* — the opposite of OpenAI's
    // convention above, where the cached count is already inside `prompt_tokens`. Left unnormalised,
    // `estimateCost` subtracts 900 from 1000 and prices this request as 100 tokens.
    expect(res.usage.inputTokens).toBe(1_900);
  });

  test("Anthropic reports writes as cache_creation_input_tokens, also outside the input count", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 40,
          output_tokens: 10,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 800,
        },
      }),
    );
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    const res = await provider.chat({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });

    // The healthy-loop shape: read the whole prior prefix, write only what the last turn added.
    expect(res.usage.cachedInputTokens).toBe(5_000);
    expect(res.usage.cacheCreationInputTokens).toBe(800);
    expect(res.usage.inputTokens).toBe(5_840);
  });

  test("the stream path reports the same three counts from message_start", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":40,' +
          '"cache_read_input_tokens":5000,"cache_creation_input_tokens":800}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      ]),
    );
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "k",
      http: { fetchImpl: fetcher.fn, sleep: noSleep },
    });

    let reported: TokenUsage | undefined;
    for await (const chunk of provider.stream({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.type === "usage") reported = chunk.usage;
    }

    // Streaming is the path the default config actually takes, so a normalisation that only landed
    // on `chat()` would be a normalisation that never ran in production.
    expect(reported?.cachedInputTokens).toBe(5_000);
    expect(reported?.cacheCreationInputTokens).toBe(800);
    expect(reported?.inputTokens).toBe(5_840);
  });

  /**
   * `message_delta`'s counts are cumulative. A proxy that learns the prompt's size only at the end (Nougate from an
   * OpenAI or Gemini upstream, 0.8.17) sends zeros at the start and the counts there: read from the start alone, the
   * turn was estimated and its cache hits were lost.
   */
  async function streamed(start: string, delta: string): Promise<(TokenUsage & { estimated?: boolean }) | undefined> {
    const fetcher = fakeFetch(
      sseResponse([
        `data: {"type":"message_start","message":{"usage":${start}}}\n\n`,
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":${delta}}\n\n`,
      ]),
    );
    const provider = new AnthropicProvider({ baseUrl: "https://nougate.example/anthropic/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    let reported: (TokenUsage & { estimated?: boolean }) | undefined;
    for await (const chunk of provider.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] })) {
      if (chunk.type === "usage") reported = chunk.usage;
    }
    return reported;
  }

  test("counts a proxy sends only on message_delta are read there, the cache included, and not estimated", async () => {
    const reported = await streamed(
      '{"input_tokens":0,"output_tokens":0}',
      '{"input_tokens":40,"cache_read_input_tokens":5000,"cache_creation_input_tokens":800,"output_tokens":10}',
    );
    expect(reported?.inputTokens).toBe(5_840);
    expect(reported?.cachedInputTokens).toBe(5_000);
    expect(reported?.cacheCreationInputTokens).toBe(800);
    expect(reported?.outputTokens).toBe(10);
    expect(reported?.estimated).toBe(false);
  });

  test("the delta's counts are totals: they replace the start's, never add to them", async () => {
    // A server tool samples more than once in one message; the delta carries the whole message's input.
    const reported = await streamed('{"input_tokens":40,"cache_read_input_tokens":5000}', '{"input_tokens":90,"cache_read_input_tokens":5000,"output_tokens":10}');
    expect(reported?.inputTokens).toBe(5_090);
    expect(reported?.cachedInputTokens).toBe(5_000);
  });

  test("the start and the delta splitting one prompt differently: the delta's split, the cache counted once", async () => {
    // Nougate's Gemini route, as the box sandbox saw it on 2026-11-04: the first chunk counts the prompt but not the
    // cache, so the start says all of it is uncached; the end gives the split. The higher of each field was 166,469.
    const reported = await streamed('{"input_tokens":84280}', '{"input_tokens":2091,"cache_read_input_tokens":82189,"output_tokens":2}');
    expect(reported?.inputTokens).toBe(84_280);
    expect(reported?.cachedInputTokens).toBe(82_189);
  });

  test("a delta that leaves the cache out, adding up to less, does not replace the start's counts", async () => {
    const reported = await streamed('{"input_tokens":500,"cache_read_input_tokens":40000}', '{"input_tokens":500,"output_tokens":10}');
    expect(reported?.inputTokens).toBe(40_500);
    expect(reported?.cachedInputTokens).toBe(40_000);
  });

  test("a delta whose input fields are zeros does not erase the start's counts", async () => {
    const reported = await streamed('{"input_tokens":40,"cache_read_input_tokens":5000}', '{"input_tokens":0,"cache_read_input_tokens":0,"output_tokens":10}');
    expect(reported?.inputTokens).toBe(5_040);
    expect(reported?.cachedInputTokens).toBe(5_000);
    expect(reported?.outputTokens).toBe(10);
  });

  test("a provider that says nothing leaves the field absent, not zero", () => {
    // NULL and 0 are different facts: "did not say" and "no hits". Only one of them means caching is
    // not working, and the gateway in front of this daemon reports the first.
    const usage = fillMissingUsage({ inputTokens: 5, outputTokens: 5 }, { messages: [] }, "hi");
    expect(usage.cachedInputTokens).toBeUndefined();
  });
});
