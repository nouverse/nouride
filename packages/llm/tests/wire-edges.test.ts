/**
 * The edges of the LLM wire fail loudly (0.7.8): a call whose arguments are not one JSON object says so instead of
 * carrying magic keys nothing read; a stream that just stops is a reply cut off, not a finished one; a body that is
 * not what the API promises is a failure with a name, not a SyntaxError or a silent empty answer.
 */

import { describe, expect, test } from "bun:test";
import { LLMError, SseStalledError, type StreamChunk } from "@nouride/shared";
import { AnthropicProvider } from "../src/anthropic.ts";
import { streamEvents } from "../src/http.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { toolArguments } from "../src/tool-arguments.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const openai = (response: Response) => new OpenAIProvider({ baseUrl: "https://api.example.com/v1", apiKey: "k", http: { fetchImpl: fakeFetch(response).fn, sleep: noSleep } });
const anthropic = (response: Response) => new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", http: { fetchImpl: fakeFetch(response).fn, sleep: noSleep } });
const drain = async (chunks: AsyncIterable<StreamChunk>) => {
  const seen: StreamChunk[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
};
const failure = async (work: Promise<unknown>): Promise<LLMError> => {
  try {
    await work;
  } catch (err) {
    if (err instanceof LLMError) return err;
    throw err;
  }
  throw new Error("it did not fail");
};

describe("a tool call's arguments", () => {
  test("read the same for every wire: an object as it is, anything else said as what it was", () => {
    expect(toolArguments('{"path":"a.txt"}')).toEqual({ arguments: { path: "a.txt" } });
    expect(toolArguments("")).toEqual({ arguments: {} });
    expect(toolArguments('{"path":')).toMatchObject({ arguments: {}, argumentsError: { raw: '{"path":', reason: expect.stringContaining("not valid JSON") } });
    expect(toolArguments('"ls -la"')).toMatchObject({ arguments: {}, argumentsError: { reason: "a JSON string, not an object" } });
    expect(toolArguments("[1,2]")).toMatchObject({ argumentsError: { reason: "a JSON array, not an object" } });
  });

  test("a streamed call cut mid-object carries the error, on both wires", async () => {
    const oa = await drain(openai(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ])).stream({ model: "m", messages: [] }));
    const call = oa.find((chunk) => chunk.type === "tool_call");
    expect(call?.type === "tool_call" && call.call.argumentsError?.raw).toBe('{"pa');

    const an = await drain(anthropic(sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    ])).stream({ model: "m", messages: [] }));
    const used = an.find((chunk) => chunk.type === "tool_call");
    expect(used?.type === "tool_call" && used.call.argumentsError?.raw).toBe('{"pa');
  });
});

describe("a stream that just stops", () => {
  test("is a reply cut off — on the OpenAI wire, with neither a finish reason nor [DONE]", async () => {
    const err = await failure(drain(openai(sseResponse(['data: {"choices":[{"delta":{"content":"Half a sen"}}]}\n\n'])).stream({ model: "m", messages: [] })));
    expect(err.status).toBe(503);
    expect(err.userMessage).toContain("ended before its reply did");
  });

  test("either end marker will do — some servers send only one", async () => {
    const withDone = await drain(openai(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"])).stream({ model: "m", messages: [] }));
    expect(withDone.at(-1)).toMatchObject({ type: "done" });
    const withReason = await drain(openai(sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'])).stream({ model: "m", messages: [] }));
    expect(withReason.at(-1)).toMatchObject({ type: "done" });
  });

  test("and on the Anthropic wire, with neither a stop reason nor message_stop", async () => {
    const cut = await failure(drain(anthropic(sseResponse(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Half"}}\n\n'])).stream({ model: "m", messages: [] })));
    expect(cut.status).toBe(503);
    const stopped = await drain(anthropic(sseResponse(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n', 'data: {"type":"message_stop"}\n\n'])).stream({ model: "m", messages: [] }));
    expect(stopped.at(-1)).toMatchObject({ type: "done" });
  });

  test("a stall is told from a drop by its type, not its words", async () => {
    const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const err = await failure((async () => {
      for await (const _ of streamEvents(silent, 20)) void _;
    })());
    expect(err.cause).toBeInstanceOf(SseStalledError);
    expect(err.userMessage).toContain("stopped sending");
  });
});

describe("a body that is not what the API promises", () => {
  test("not JSON is a failure with a name, on both wires — never a SyntaxError", async () => {
    const html = () => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
    for (const err of [await failure(openai(html()).chat({ model: "m", messages: [] })), await failure(anthropic(html()).chat({ model: "m", messages: [] }))]) {
      expect(err.status).toBe(502);
      expect(err.userMessage).toContain("could not read");
    }
  });

  test("an Anthropic answer with no content is refused, not an empty reply", async () => {
    const err = await failure(anthropic(jsonResponse({ type: "message", stop_reason: "end_turn" })).chat({ model: "m", messages: [] }));
    expect(err.status).toBe(502);
  });

  test("an Anthropic answer streamed although it was not asked for is read as the stream it is", async () => {
    const res = await anthropic(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed anyway"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    ])).chat({ model: "m", messages: [] });
    expect(res.text).toBe("streamed anyway");
  });
});
