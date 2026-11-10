/**
 * Who is asking, on the wire — for a profile that says `identify`, and only for one.
 *
 * Nougate tells clients apart by `x-client-id` and sessions by `user`; OpenAI routes a request to the cache its
 * prefix is in by `prompt_cache_key`. Nouride sent none of them, so every agent was one client and two agents in
 * one chat one session. A strict server rejects a field it does not know, which is why it is a profile's choice.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { LLMError } from "@nouride/shared";
import { failedVia, postJson, servedBy } from "../src/http.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const identity = { agentId: "nouva", conversation: "5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f" };
const asked = { model: "m", messages: [{ role: "user" as const, content: "hi" }], identity };

describe("OpenAI-compatible", () => {
  const answer = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

  test("identified: the agent and conversation in `user`, the conversation as the cache key, the agent as the client", async () => {
    const fetcher = fakeFetch(answer());
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", identify: true, http: { fetchImpl: fetcher.fn, sleep: noSleep } }).chat(asked);
    expect(fetcher.last().body).toMatchObject({ user: "nouva:5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f", prompt_cache_key: "5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f" });
    expect(fetcher.last().headers["x-client-id"]).toBe("nouride/nouva");
  });

  test("not identified: none of it, whatever the caller passed", async () => {
    const fetcher = fakeFetch(answer());
    await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } }).chat(asked);
    expect(fetcher.last().body.user).toBeUndefined();
    expect(fetcher.last().body.prompt_cache_key).toBeUndefined();
    expect(fetcher.last().headers["x-client-id"]).toBeUndefined();
  });
});

describe("Anthropic", () => {
  const answer = () => jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

  test("identified: `metadata.user_id`, the Messages API's own field for it; not identified: nothing", async () => {
    const on = fakeFetch(answer());
    await new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", identify: true, http: { fetchImpl: on.fn, sleep: noSleep } }).chat(asked);
    expect(on.last().body.metadata).toEqual({ user_id: "nouva:5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f" });

    const off = fakeFetch(answer());
    await new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: off.fn, sleep: noSleep } }).chat(asked);
    expect(off.last().body.metadata).toBeUndefined();
  });
});

/**
 * Who answered, read back: Nougate says on every response which provider served the call, with which model,
 * after how many tries. `llm_usage` kept only what was asked, so its rows could not be split by what ran them.
 */
describe("who answered, when a gateway says", () => {
  const SAID = { "x-nougate-provider": "anthropic", "x-nougate-model": "claude-sonnet-4-6", "x-nougate-attempts": "2" };
  const withHeaders = (response: Response) => {
    for (const [name, value] of Object.entries(SAID)) response.headers.set(name, value);
    return response;
  };

  test("read off the headers, each only when it is there and makes sense", () => {
    expect(servedBy(new Headers(SAID))).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", attempts: 2 });
    expect(servedBy(new Headers({ "x-nougate-provider": "openai", "x-nougate-attempts": "zero" }))).toEqual({ provider: "openai" });
    // A count of none is not a count: something answered, so it was tried at least once.
    expect(servedBy(new Headers({ "x-nougate-provider": "openai", "x-nougate-attempts": "0" }))).toEqual({ provider: "openai" });
    expect(servedBy(new Headers({ "content-type": "application/json" }))).toBeUndefined();
  });

  test("on the usage of an answer, whole or streamed", async () => {
    const whole = fakeFetch(withHeaders(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })));
    const answer = await new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: whole.fn, sleep: noSleep } }).chat({ model: "router:smart", messages: [{ role: "user", content: "hi" }] });
    expect(answer.usage?.upstream).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", attempts: 2 });

    const streamed = fakeFetch(
      withHeaders(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
    );
    let usage: { upstream?: unknown } | undefined;
    for await (const event of new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: streamed.fn, sleep: noSleep } }).stream({ model: "router:smart", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "usage") usage = event.usage;
    }
    expect(usage?.upstream).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", attempts: 2 });
  });
});

/**
 * Who was tried, when nothing answered: when every provider behind Nougate threw, its
 * error response carried no attribution, and Nouride read the x-nougate headers only off an answer anyway. Nougate now
 * says `x-nougate-tried` and `-attempts` on the error; the error a call ends with carries them, structured and in its
 * message — which is what a failed turn records — and never in what the chat is told.
 */
describe("who was tried, when the call failed", () => {
  const TRIED = { "x-nougate-tried": "antigravity,claudecode", "x-nougate-attempts": "2" };
  const failing = (status: number, headers: Record<string, string>) =>
    new Response(JSON.stringify({ error: { message: "every provider failed" } }), { status, headers: { "content-type": "application/json", ...headers } });
  const failure = async (status: number, headers: Record<string, string>) =>
    (await postJson("https://gw.test/v1/chat/completions", {}, {}, undefined, { fetchImpl: fakeFetch(failing(status, headers)).fn, sleep: noSleep, maxAttempts: 1 }).catch(
      (error: unknown) => error,
    )) as LLMError;

  test("read off the headers: the providers in order, and how many", () => {
    expect(failedVia(new Headers(TRIED))).toEqual({ attempts: 2, tried: ["antigravity", "claudecode"] });
    expect(failedVia(new Headers({ ...TRIED, "x-nougate-provider": "antigravity", "x-nougate-model": "m" }))).toEqual({
      provider: "antigravity",
      model: "m",
      attempts: 2,
      tried: ["antigravity", "claudecode"],
    });
    expect(failedVia(new Headers({ "x-nougate-tried": " , " }))).toBeUndefined();
    expect(failedVia(new Headers({ "content-type": "application/json" }))).toBeUndefined();
  });

  test("a 502 the gateway answered for every provider names them, on the error and in its message", async () => {
    const error = await failure(502, TRIED);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.upstream).toEqual({ attempts: 2, tried: ["antigravity", "claudecode"] });
    expect(error.message).toEndWith("(through nougate, tried antigravity, claudecode)");
    // What a failed turn keeps for the operator is `String(err)`; what the chat is told is not this.
    expect(String(error)).toContain("tried antigravity, claudecode");
    expect(error.userMessage).not.toContain("antigravity");
  });

  test("a refusal that is not retried says it too, and a failure with nothing in between says nothing more", async () => {
    expect((await failure(400, TRIED)).upstream?.tried).toEqual(["antigravity", "claudecode"]);
    const plain = await failure(502, {});
    expect(plain.upstream).toBeUndefined();
    expect(plain.message).not.toContain("nougate");
  });

  test("an older gateway that names only whose failure it handed back is said as that", async () => {
    const error = await failure(429, { "x-nougate-provider": "antigravity", "x-nougate-attempts": "2" });
    expect(error.upstream).toEqual({ provider: "antigravity", attempts: 2 });
    expect(error.message).toEndWith("(through nougate: antigravity, 2 tried)");
  });
});
