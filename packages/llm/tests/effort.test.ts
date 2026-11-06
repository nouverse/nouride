/**
 * How long a model thinks, on the wire (`ChatParams.effort`): `output_config.effort` on the Messages API, `reasoning_effort`
 * on an OpenAI-compatible endpoint — and nothing at all when the agent sets none, so the provider's default stands.
 *
 * Measured through nougate (2026-10-21): Claude Sonnet 5.5 at its default thought for 22 s before a ten-sentence answer;
 * at `medium`, 2 s.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.ts";

const asked = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("Anthropic", () => {
  const answer = () => jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

  test("inside `output_config`, not a top-level field; absent when unset", async () => {
    const set = fakeFetch(answer());
    await new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: set.fn, sleep: noSleep } }).chat({ ...asked, effort: "medium" });
    expect(set.last().body.output_config).toEqual({ effort: "medium" });
    expect(set.last().body.effort).toBeUndefined();

    const unset = fakeFetch(answer());
    await new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: unset.fn, sleep: noSleep } }).chat(asked);
    expect(unset.last().body.output_config).toBeUndefined();
  });
});

describe("OpenAI-compatible", () => {
  const answer = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

  test("as `reasoning_effort`, the level as written; absent when unset", async () => {
    const set = fakeFetch(answer());
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: set.fn, sleep: noSleep } }).chat({ ...asked, effort: "xhigh" });
    expect(set.last().body.reasoning_effort).toBe("xhigh");

    const unset = fakeFetch(answer());
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: unset.fn, sleep: noSleep } }).chat(asked);
    expect(unset.last().body.reasoning_effort).toBeUndefined();
  });
});

/**
 * A model that will not take it. `[llm.defaults] effort` reaches every agent, and an OpenAI model that does not reason,
 * an older Claude or a gateway's Gemini at `xhigh` answers 400 — every turn of that agent failing on a setting meant to
 * make it faster.
 */
describe("a model that refuses the level", () => {
  // Worded as no endpoint words it: the guard reads the answer, not the vendor's sentence.
  const refusing = (field: string, ok: () => Response) =>
    fakeFetch((request) => (JSON.stringify(request.body).includes(field) ? jsonResponse({ error: { message: "invalid request" } }, 400) : ok()));

  test("is asked once more without it, and sent none from then on — the same profile's other models still are", async () => {
    const fetcher = refusing("reasoning_effort", () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const provider = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    expect((await provider.chat({ ...asked, effort: "medium" })).text).toBe("ok");
    expect(fetcher.requests.map((r) => r.body.reasoning_effort)).toEqual(["medium", undefined]);

    await provider.chat({ ...asked, effort: "medium" });
    expect(fetcher.requests).toHaveLength(3);
    expect(fetcher.last().body.reasoning_effort).toBeUndefined();

    await provider.chat({ ...asked, model: "o-reasoner", effort: "medium" }).catch(() => {});
    expect(fetcher.requests[3]?.body.reasoning_effort).toBe("medium");
  });

  test("on the Messages API too, by `output_config`", async () => {
    const fetcher = refusing("output_config", () =>
      jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    expect((await provider.chat({ ...asked, effort: "xhigh" })).text).toBe("ok");
    expect(fetcher.requests.map((r) => r.body.output_config)).toEqual([{ effort: "xhigh" }, undefined]);
  });

  test("a 400 the effort did not cause fails as it would have, and the model keeps getting it", async () => {
    const fetcher = fakeFetch(jsonResponse({ error: { message: "messages: at least one message is required" } }, 400));
    const provider = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    await expect(provider.chat({ ...asked, effort: "medium" })).rejects.toThrow(/at least one message/);
    expect(fetcher.requests.map((r) => r.body.reasoning_effort)).toEqual(["medium", undefined]);
    await provider.chat({ ...asked, effort: "medium" }).catch(() => {});
    expect(fetcher.requests[2]?.body.reasoning_effort).toBe("medium");
  });

  /**
   * Its caller hears each request that went without the level (0.8.17): a chat that set `/effort` is told with the answer,
   * where only the log was, which says it once per model. The refusal itself and every request after it alike.
   */
  test("tells its caller each request it sends without the level, and nothing for one it sends with it", async () => {
    const fetcher = refusing("reasoning_effort", () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const provider = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    const heard: unknown[] = [];
    const onEffortRefused = (refusal: unknown) => void heard.push(refusal);
    await provider.chat({ ...asked, effort: "high", onEffortRefused });
    expect(heard).toEqual([{ effort: "high", model: "m" }]);
    await provider.chat({ ...asked, effort: "high", onEffortRefused });
    expect(heard).toEqual([{ effort: "high", model: "m" }, { effort: "high", model: "m" }]);
    expect(fetcher.requests).toHaveLength(3);
    // Asked of a model that takes it, or with no level at all: nothing to tell.
    const taking = fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const other = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: taking.fn, sleep: noSleep } });
    await other.chat({ ...asked, effort: "high", onEffortRefused });
    await provider.chat({ ...asked, onEffortRefused });
    expect(heard).toHaveLength(2);
  });

  test("a 400 the effort did not cause tells its caller nothing", async () => {
    const fetcher = fakeFetch(jsonResponse({ error: { message: "messages: at least one message is required" } }, 400));
    const provider = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    const heard: unknown[] = [];
    await provider.chat({ ...asked, effort: "medium", onEffortRefused: (refusal) => void heard.push(refusal) }).catch(() => {});
    expect(heard).toEqual([]);
  });

  test("nothing extra without an effort, or on any failure but a 400", async () => {
    const plain = fakeFetch(jsonResponse({ error: { message: "bad" } }, 400));
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: plain.fn, sleep: noSleep } }).chat(asked).catch(() => {});
    expect(plain.requests).toHaveLength(1);

    const denied = fakeFetch(jsonResponse({ error: { message: "no access" } }, 403));
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: denied.fn, sleep: noSleep } }).chat({ ...asked, effort: "medium" }).catch(() => {});
    expect(denied.requests).toHaveLength(1);
  });
});
