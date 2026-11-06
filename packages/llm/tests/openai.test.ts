import { describe, expect, test } from "bun:test";
import type { StreamChunk } from "@nouride/shared";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

function provider(fetchImpl: typeof fetch) {
  return new OpenAIProvider({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-test",
    http: { fetchImpl, sleep: noSleep },
  });
}

describe("OpenAIProvider.chat", () => {
  test("sends the system prompt as the first message and strips the trailing slash", async () => {
    const fetcher = fakeFetch(
      jsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    );
    await provider(fetcher.fn).chat({
      model: "gpt-4o",
      system: "you are a bot",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetcher.last().url).toBe("https://api.example.com/v1/chat/completions");
    expect(fetcher.last().headers.authorization).toBe("Bearer sk-test");
    expect(fetcher.last().body.messages).toEqual([
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hello" },
    ]);
  });

  test("the tail is the last message, after everything an implicit cache can match", async () => {
    const fetcher = fakeFetch(jsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }));
    await provider(fetcher.fn).chat({
      model: "gpt-4o",
      system: "you are a bot",
      messages: [{ role: "user", content: "hello" }],
      tail: "NOTES\n## A task",
    });
    expect(fetcher.last().body.messages).toEqual([
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hello" },
      { role: "user", content: "NOTES\n## A task" },
    ]);
  });

  test("maps text responses and usage", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        model: "gpt-4o-2024",
        choices: [{ message: { content: "the answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const res = await provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] });

    expect(res.text).toBe("the answer");
    expect(res.stopReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7, estimated: false, attempts: 1, latencyMs: expect.any(Number), stopReason: "stop" });
    expect(res.model).toBe("gpt-4o-2024");
  });

  test("thinking a gateway left out of completion_tokens is read from total_tokens — on both paths", async () => {
    // Nougate's Antigravity route: completion_tokens is Gemini's answer alone, total_tokens its whole count.
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 1_120 };
    const whole = await provider(fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage })).fn).chat({ model: "gemini-3.8-flash", messages: [] });
    expect(whole.usage).toMatchObject({ inputTokens: 100, outputTokens: 1_020 });

    const chunks: StreamChunk[] = [];
    const streamed = sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\n`, "data: [DONE]\n\n"]);
    for await (const chunk of provider(fakeFetch(streamed).fn).stream({ model: "gemini-3.8-flash", messages: [] })) chunks.push(chunk);
    expect(chunks.find((chunk) => chunk.type === "usage")).toMatchObject({ usage: { inputTokens: 100, outputTokens: 1_020 } });

    // OpenAI's own: total is prompt plus completion, and nothing is counted twice.
    const plain = await provider(fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })).fn).chat({ model: "gpt-5", messages: [] });
    expect(plain.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  test("parses tool calls and reports stopReason tool_calls", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const res = await provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] });

    expect(res.stopReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: { path: "a.txt" } }]);
  });

  test("surfaces malformed tool arguments instead of throwing", async () => {
    // Models do emit broken JSON. Throwing would abort the turn; this way the tool
    // layer can answer with an error the model sees and corrects.
    const fetcher = fakeFetch(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read", arguments: "{oops" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const res = await provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] });
    expect(res.toolCalls[0]?.arguments).toEqual({});
    expect(res.toolCalls[0]?.argumentsError).toEqual({ raw: "{oops", reason: expect.stringContaining("not valid JSON") });
  });

  test("round-trips an assistant tool call and its result", async () => {
    const fetcher = fakeFetch(jsonResponse({ choices: [{ message: { content: "done" } }] }));
    await provider(fetcher.fn).chat({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }],
        },
        { role: "tool", content: "file body", toolCallId: "c1" },
      ],
    });

    const [, assistant, tool] = fetcher.last().body.messages;
    // content must be null, not "": some compatible servers reject an empty string
    // alongside tool_calls.
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls[0].function.arguments).toBe('{"path":"a.txt"}');
    expect(tool).toEqual({ role: "tool", content: "file body", tool_call_id: "c1" });
  });

  test("asks for no stream outright — a proxy that defaults to streaming sees `false`, not nothing", async () => {
    const fetcher = fakeFetch(jsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }));
    await provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] });

    expect(fetcher.last().body.stream).toBe(false);
    expect(fetcher.last().body).not.toHaveProperty("stream_options");
  });

  // nouride-releases#6: streaming off, a 9Router route answered with SSE anyway, and the turn died on
  // "JSON Parse error: Unexpected identifier data".
  test("reads an answer streamed although it was not asked for — text, tool calls, usage", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    for (const response of [sseResponse(events), new Response(events.join(""), { headers: { "content-type": "application/json" } })]) {
      const res = await provider(fakeFetch(response).fn).chat({ model: "gpt-4o", messages: [] });

      expect(res).toEqual({
        text: "Hello",
        toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a" } }],
        stopReason: "tool_calls",
        usage: { inputTokens: 3, outputTokens: 2, estimated: false, attempts: 1, latencyMs: expect.any(Number), stopReason: "tool_calls" },
        model: "gpt-4o",
      });
    }
  });

  test("omits tools, temperature and max_tokens when unset", async () => {
    const fetcher = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));
    await provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] });

    expect(fetcher.last().body).not.toHaveProperty("tools");
    expect(fetcher.last().body).not.toHaveProperty("temperature");
    expect(fetcher.last().body).not.toHaveProperty("max_tokens");
  });

  test("wraps tool definitions in the function envelope", async () => {
    const fetcher = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));
    await provider(fetcher.fn).chat({
      model: "gpt-4o",
      messages: [],
      tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
    });

    expect(fetcher.last().body.tools).toEqual([
      {
        type: "function",
        function: { name: "read", description: "read a file", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("OpenAIProvider.stream", () => {
  async function drain(chunks: StreamChunk[] | AsyncIterable<StreamChunk>) {
    const out: StreamChunk[] = [];
    for await (const chunk of chunks) out.push(chunk);
    return out;
  }

  test("yields text deltas then usage and done", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const chunks = await drain(provider(fetcher.fn).stream({ model: "gpt-4o", messages: [] }));

    expect(fetcher.last().body.stream).toBe(true);
    expect(chunks).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2, estimated: false, attempts: 1, latencyMs: expect.any(Number), stopReason: "stop" } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  test("assembles tool call arguments streamed in fragments", async () => {
    // This is the case that motivates buffering: no single delta holds parseable JSON.
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const chunks = await drain(provider(fetcher.fn).stream({ model: "gpt-4o", messages: [] }));

    expect(chunks).toContainEqual({
      type: "tool_call",
      call: { id: "c1", name: "exec", arguments: { cmd: "ls" } },
    });
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "tool_calls" });
  });

  test("keeps multiple parallel tool calls in index order", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"two","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    );

    const calls = (await drain(provider(fetcher.fn).stream({ model: "gpt-4o", messages: [] })))
      .filter((c): c is Extract<StreamChunk, { type: "tool_call" }> => c.type === "tool_call")
      .map((c) => c.call.name);

    expect(calls).toEqual(["one", "two"]);
  });

  /**
   * SSE frames built from objects rather than hand-escaped strings.
   *
   * The first version of these fixtures wrote the JSON inline, and the nested escaping (a TS string
   * holding JSON whose *values* are JSON) silently produced invalid frames — the stream yielded nothing
   * and the test failed for a reason that had nothing to do with the code under test.
   */
  const frames = (...deltas: unknown[]): string[] => [
    ...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  ];

  const toolCallsOf = async (lines: string[]) =>
    (await drain(provider(fakeFetch(sseResponse(lines)).fn).stream({ model: "x", messages: [] })))
      .filter((c): c is Extract<StreamChunk, { type: "tool_call" }> => c.type === "tool_call")
      .map((c) => c.call);

  test("parallel calls that all share index 0 are kept apart by their id", async () => {
    // Observed against Nougate, and it broke every turn where the model wanted two tools at once —
    // which is most non-trivial ones. Vertex behind it emits parallel calls **all at `index: 0`** with a
    // distinct `id` each, so index-only keying concatenated their arguments into
    // `{"pattern":"FIXME"}{"pattern":"**/app.js"}` — which parses as nothing. The agent then retried the
    // same malformed call to the iteration cap and told the user its tools were broken.
    const calls = await toolCallsOf(
      frames(
        {
          tool_calls: [
            { index: 0, id: "toolu_a", function: { name: "glob", arguments: '{"pattern":"FIXME"}' } },
          ],
        },
        {
          tool_calls: [
            { index: 0, id: "toolu_b", function: { name: "glob", arguments: '{"pattern":"**/app.js"}' } },
          ],
        },
      ),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.arguments).toEqual({ pattern: "FIXME" });
    expect(calls[1]?.arguments).toEqual({ pattern: "**/app.js" });
    // Distinct ids, or the tool results cannot be matched back to their calls.
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  test("a fragment with no id is a continuation, not a new call", async () => {
    // Standard OpenAI sends `id` only on the first frame of each call. Treating an id-less fragment as a
    // new call would split every multi-fragment argument object into pieces.
    const calls = await toolCallsOf(
      frames(
        { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({ x: 1 });
  });

  test("a missing index does not collapse distinct calls together", async () => {
    // Some compatible servers omit `index` entirely. Defaulting it to 0 is safe only because the id
    // still separates the calls.
    const calls = await toolCallsOf(
      frames(
        { tool_calls: [{ id: "a", function: { name: "f", arguments: "{}" } }] },
        { tool_calls: [{ id: "b", function: { name: "g", arguments: "{}" } }] },
      ),
    );

    expect(calls.map((c) => c.name)).toEqual(["f", "g"]);
  });
});

describe("OpenAIProvider error handling", () => {

  test("does not retry a 400", async () => {
    // A malformed request will be malformed on the third attempt too. Retrying only
    // burns the rate limit.
    const fetcher = fakeFetch(jsonResponse({ error: "bad request" }, 400));
    await expect(provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] })).rejects.toThrow(
      /400/,
    );
    expect(fetcher.requests).toHaveLength(1);
  });

  test("gives up after the attempt budget", async () => {
    const fetcher = fakeFetch(jsonResponse({ error: "boom" }, 503));
    await expect(provider(fetcher.fn).chat({ model: "gpt-4o", messages: [] })).rejects.toThrow(
      /503/,
    );
    // Six: half a minute of backoff, so one gateway restart does not end an hour-long turn.
    expect(fetcher.requests).toHaveLength(6);
  });
});
