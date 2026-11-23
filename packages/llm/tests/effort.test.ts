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
import { fakeFetch, jsonResponse, noSleep, sseResponse, type FakeFetch } from "./helpers.ts";

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

/**
 * A model that takes no tools while it reasons. OpenAI's newer models answer 400 on `/chat/completions` to a request with
 * function tools unless it says `reasoning_effort: "none"`, the level left out included: a hosted install's agent there
 * answered a plain question and failed at every tool ("Function tools with reasoning_effort are not supported for … in
 * /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."). Its effort was
 * `low`; asked again without it, the answer was the same, and no level an agent can be set to says "none".
 */
describe("a model that takes no tools while it reasons", () => {
  const tools = [{ name: "look", description: "", parameters: { type: "object", properties: {} } }];
  const ok = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  // Worded as no endpoint words it. With tools, only `none` passes; with none, anything does.
  const refusal = () => jsonResponse({ error: { message: "invalid request" } }, 400);
  const strict = () => fakeFetch((request) => (request.body.tools && request.body.reasoning_effort !== "none" ? refusal() : ok()));
  const openai = (fetcher: FakeFetch) => new OpenAIProvider({ baseUrl: "https://api.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
  const efforts = (fetcher: FakeFetch) => fetcher.requests.map((request) => request.body.reasoning_effort);

  test("with an effort: asked without it, then saying not to reason, and that model's requests with tools say so from then on", async () => {
    const fetcher = strict();
    const provider = openai(fetcher);
    const heard: unknown[] = [];
    const onEffortRefused = (refusal: unknown) => void heard.push(refusal);
    expect((await provider.chat({ ...asked, tools, effort: "low", onEffortRefused })).text).toBe("ok");
    expect(efforts(fetcher)).toEqual(["low", undefined, "none"]);
    // The next one goes straight out saying it: one request, not three.
    expect((await provider.chat({ ...asked, tools, effort: "low", onEffortRefused })).text).toBe("ok");
    expect(efforts(fetcher)).toEqual(["low", undefined, "none", "none"]);
    // A chat that set its effort hears each time it was not used.
    expect(heard).toEqual([{ effort: "low", model: "m" }, { effort: "low", model: "m" }]);
  });

  test("with no effort set, where the model's own default reasons: asked once more saying not to", async () => {
    const fetcher = strict();
    const provider = openai(fetcher);
    expect((await provider.chat({ ...asked, tools })).text).toBe("ok");
    expect(efforts(fetcher)).toEqual([undefined, "none"]);
    await provider.chat({ ...asked, tools });
    expect(efforts(fetcher)).toEqual([undefined, "none", "none"]);
  });

  test("streamed, as a daemon asks by default", async () => {
    const fetcher = fakeFetch((request) =>
      request.body.tools && request.body.reasoning_effort !== "none"
        ? refusal()
        : sseResponse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }].map((event) => `data: ${JSON.stringify(event)}\n\n`).concat("data: [DONE]\n\n")),
    );
    let text = "";
    for await (const chunk of openai(fetcher).stream({ ...asked, tools, effort: "medium" })) if (chunk.type === "text") text += chunk.delta;
    expect(text).toBe("ok");
    expect(efforts(fetcher)).toEqual(["medium", undefined, "none"]);
    expect(fetcher.requests.every((request) => request.body.stream === true)).toBe(true);
  });

  test("its requests without tools keep the effort they asked for, and another model is asked as it was", async () => {
    const fetcher = strict();
    const provider = openai(fetcher);
    await provider.chat({ ...asked, tools, effort: "low" });
    const before = fetcher.requests.length;
    await provider.chat({ ...asked, effort: "low" });
    expect(efforts(fetcher).slice(before)).toEqual(["low"]);
    await provider.chat({ ...asked, model: "other", tools, effort: "low" });
    expect(efforts(fetcher).slice(before + 1)).toEqual(["low", undefined, "none"]);
  });

  test("a 400 that not reasoning does not cure fails with the first answer, and nothing is remembered", async () => {
    const answers = ["tools: the first refusal", "the second", "the third"];
    const fetcher = fakeFetch(() => jsonResponse({ error: { message: answers.shift() ?? "later" } }, 400));
    const provider = openai(fetcher);
    await expect(provider.chat({ ...asked, tools, effort: "low" })).rejects.toThrow(/the first refusal/);
    expect(efforts(fetcher)).toEqual(["low", undefined, "none"]);
    await provider.chat({ ...asked, tools, effort: "low" }).catch(() => {});
    expect(efforts(fetcher).slice(3)).toEqual(["low", undefined, "none"]);
  });

  test("a second try that fails another way ends it there: a quota spent is not asked a third time", async () => {
    let n = 0;
    const fetcher = fakeFetch(() => (++n === 1 ? jsonResponse({ error: { message: "the refusal" } }, 400) : jsonResponse({ error: { message: "no credits" } }, 402)));
    await expect(openai(fetcher).chat({ ...asked, tools, effort: "low" })).rejects.toThrow(/the refusal/);
    expect(fetcher.requests).toHaveLength(2);
  });

  test("nothing extra for a refused request that carries no tools", async () => {
    const fetcher = fakeFetch(refusal());
    await openai(fetcher).chat({ ...asked, effort: "low" }).catch(() => {});
    expect(efforts(fetcher)).toEqual(["low", undefined]);
    const bare = fakeFetch(refusal());
    await openai(bare).chat(asked).catch(() => {});
    expect(bare.requests).toHaveLength(1);
  });

  test("the Messages API has no such word: asked without the level, and no more", async () => {
    const fetcher = fakeFetch(refusal());
    const provider = new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    await provider.chat({ ...asked, tools, effort: "low" }).catch(() => {});
    expect(fetcher.requests).toHaveLength(2);
    expect(JSON.stringify(fetcher.requests.map((request) => request.body))).not.toContain("none");
  });
});
