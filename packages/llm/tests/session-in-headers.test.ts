/**
 * `{session}` in a profile's extra headers: where the conversation's id is written on each request.
 *
 * OpenCode Go answers 400 `MissingSessionID` to any request without `x-opencode-session`, on either format, and asks
 * for an id that stays the same through a conversation: it routes and caches by it. A profile's headers were sent as
 * written, so one on a Go subscription refused every request. A header says where the id goes, and the client writes
 * the conversation's there: the same for every request of it, and an id of the one call where nothing names a
 * conversation, since a request without it is refused.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { profileHeaders, SESSION_PLACEHOLDER } from "../src/http.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const HEADER = "x-opencode-session";
const GO = { [HEADER]: "{session}" };
const HEX = /^[0-9a-f]{32}$/;
const conversation = "5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f";
const asked = { model: "m", messages: [{ role: "user" as const, content: "hi" }], identity: { agentId: "nouva", conversation } };
const unnamed = { model: "m", messages: [{ role: "user" as const, content: "summarize this" }] };

const openaiAnswer = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
const anthropicAnswer = () => jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

describe("a profile's headers, as one request sends them", () => {
  test("the conversation's id goes where a value asks for it, in every header that asks, and the rest are as written", () => {
    expect(SESSION_PLACEHOLDER).toBe("{session}");
    expect(profileHeaders({ [HEADER]: "{session}", "x-trace": "nouride-{session}-{session}", "HTTP-Referer": "https://example.test", "x-odd": "{not-session}" }, conversation)).toEqual({
      [HEADER]: conversation,
      "x-trace": `nouride-${conversation}-${conversation}`,
      "HTTP-Referer": "https://example.test",
      "x-odd": "{not-session}",
    });
  });

  test("with no conversation, an id of the one request: the same in each header of it, another for the next", () => {
    const first = profileHeaders({ [HEADER]: "{session}", "x-trace": "{session}" });
    const second = profileHeaders(GO);
    expect(first[HEADER]).toMatch(HEX);
    expect(first["x-trace"]).toBe(first[HEADER]!);
    expect(second[HEADER]).toMatch(HEX);
    expect(second[HEADER]).not.toBe(first[HEADER]);
  });

  test("no headers is none, and headers that ask for nothing are the same headers", () => {
    expect(profileHeaders(undefined, conversation)).toEqual({});
    expect(profileHeaders({ "x-team": "ops" }, conversation)).toEqual({ "x-team": "ops" });
  });
});

describe("OpenAI-compatible, a profile whose header asks for the conversation", () => {
  const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => new OpenAIProvider({ baseUrl: "https://go.test/v1", apiKey: "k", headers: GO, http: { fetchImpl, sleep: noSleep }, ...extra });

  test("says it without `identify`: the header is the profile's own, and what `identify` sends stays that key's", async () => {
    const fetcher = fakeFetch(openaiAnswer());
    await client(fetcher.fn).chat(asked);
    expect(fetcher.last().headers).toEqual({ "content-type": "application/json", authorization: "Bearer k", [HEADER]: conversation });
    expect(fetcher.last().body.user).toBeUndefined();
  });

  test("the same id on every request of a conversation, streamed or whole", async () => {
    const whole = fakeFetch(openaiAnswer());
    await client(whole.fn).chat(asked);
    const streamed = fakeFetch(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"]));
    for await (const _ of client(streamed.fn).stream(asked)) void _;
    expect([whole.last().headers[HEADER], streamed.last().headers[HEADER]]).toEqual([conversation, conversation]);
  });

  test("a request nothing names a conversation for carries an id of its own: one per call, never the bare placeholder", async () => {
    const first = fakeFetch(openaiAnswer());
    const second = fakeFetch(openaiAnswer());
    await client(first.fn).chat(unnamed);
    await client(second.fn).chat(unnamed);
    const ids = [first.last().headers[HEADER], second.last().headers[HEADER]];
    for (const id of ids) expect(id).toMatch(HEX);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("an embedding carries one too: the endpoint refuses any request without it", async () => {
    const fetcher = fakeFetch(jsonResponse({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }));
    await client(fetcher.fn).embed({ model: "e", input: ["a"] });
    expect(fetcher.last().headers[HEADER]).toMatch(HEX);
  });

  test("with `identify` too, the header and the cache key name the same conversation", async () => {
    const fetcher = fakeFetch(openaiAnswer());
    await client(fetcher.fn, { identify: true }).chat(asked);
    expect(fetcher.last().headers[HEADER]).toBe(conversation);
    expect(fetcher.last().body.prompt_cache_key).toBe(conversation);
    expect(fetcher.last().headers["x-client-id"]).toBe("nouride/nouva");
  });
});

describe("Anthropic, a profile whose header asks for the conversation", () => {
  const client = (fetchImpl: typeof fetch) => new AnthropicProvider({ baseUrl: "https://go.test/v1", apiKey: "k", headers: GO, http: { fetchImpl, sleep: noSleep } });

  test("says it beside the key and the version, and an id of its own where there is none", async () => {
    const named = fakeFetch(anthropicAnswer());
    await client(named.fn).chat(asked);
    expect(named.last().headers).toMatchObject({ [HEADER]: conversation, "x-api-key": "k" });
    expect(Object.keys(named.last().headers).sort()).toEqual(["anthropic-version", "content-type", "x-api-key", HEADER]);
    expect(named.last().body.metadata).toBeUndefined();

    const alone = fakeFetch(anthropicAnswer());
    await client(alone.fn).chat(unnamed);
    expect(alone.last().headers[HEADER]).toMatch(HEX);
  });
});
