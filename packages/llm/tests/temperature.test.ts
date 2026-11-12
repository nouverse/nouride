/**
 * A model that will not take a temperature (`TemperatureGuard`). Every request carries one, `[llm.defaults] temperature`
 * or the 0 that compaction, the memory pass and reflection ask at, and Claude Sonnet 5.5 and Haiku 5.5 answered each
 * with 400 "`temperature` is deprecated for this model": every turn of every agent on them failed.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse, type RecordedRequest } from "./helpers.ts";

const asked = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

const messagesAnswer = () =>
  jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
const completionsAnswer = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

// Worded as no endpoint words it: the guard reads the answer, not the vendor's sentence.
const refused = () => jsonResponse({ error: { message: "invalid request" } }, 400);
/** An endpoint that answers 400 to a request carrying any of `fields`, at any value. */
const refusing = (fields: string[], ok: () => Response) => fakeFetch((request) => (fields.some((field) => field in request.body) ? refused() : ok()));

const anthropic = (fetcher: { fn: typeof fetch }) => new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
const openai = (fetcher: { fn: typeof fetch }) => new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
const temperatures = (requests: RecordedRequest[]) => requests.map((request) => request.body.temperature);

describe("a model that refuses the temperature", () => {
  test("is asked once more without it, and sent none from then on — the same profile's other models still are", async () => {
    const fetcher = refusing(["temperature"], messagesAnswer);
    const provider = anthropic(fetcher);
    expect((await provider.chat({ ...asked, temperature: 0.7 })).text).toBe("ok");
    expect(temperatures(fetcher.requests)).toEqual([0.7, undefined]);

    await provider.chat({ ...asked, temperature: 0.7 });
    expect(fetcher.requests).toHaveLength(3);
    expect(fetcher.last().body).not.toHaveProperty("temperature");

    await provider.chat({ ...asked, model: "another", temperature: 0.7 });
    expect(fetcher.requests[3]?.body.temperature).toBe(0.7);
  });

  test("on a streamed request too, the one a turn makes", async () => {
    const fetcher = refusing(["temperature"], () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    let text = "";
    for await (const chunk of anthropic(fetcher).stream({ ...asked, temperature: 0.7 })) if (chunk.type === "text") text += chunk.delta;
    expect(text).toBe("ok");
    expect(temperatures(fetcher.requests)).toEqual([0.7, undefined]);
  });

  // 0 is a temperature: the one compaction, the memory pass and reflection ask at, and as refused as 0.7.
  test("at 0 as well, on an OpenAI-compatible endpoint", async () => {
    const fetcher = refusing(["temperature"], completionsAnswer);
    const provider = openai(fetcher);
    expect((await provider.chat({ ...asked, temperature: 0 })).text).toBe("ok");
    expect(temperatures(fetcher.requests)).toEqual([0, undefined]);
    await provider.chat({ ...asked, temperature: 0 });
    expect(fetcher.requests).toHaveLength(3);
    expect(fetcher.last().body).not.toHaveProperty("temperature");
  });

  test("keeps the effort it takes: only the temperature is dropped", async () => {
    const fetcher = refusing(["temperature"], messagesAnswer);
    const provider = anthropic(fetcher);
    expect((await provider.chat({ ...asked, temperature: 0.7, effort: "medium" })).text).toBe("ok");
    expect(fetcher.last().body).not.toHaveProperty("temperature");
    expect(fetcher.last().body.output_config).toEqual({ effort: "medium" });

    await provider.chat({ ...asked, temperature: 0.7, effort: "medium" });
    expect(fetcher.last().body).not.toHaveProperty("temperature");
    expect(fetcher.last().body.output_config).toEqual({ effort: "medium" });
    // One request for the second ask: neither guard asks twice once it knows.
    const before = fetcher.requests.length;
    await provider.chat({ ...asked, temperature: 0.7, effort: "medium" });
    expect(fetcher.requests).toHaveLength(before + 1);
  });

  test("one that refuses the effort as well is answered with neither, and sent neither after", async () => {
    const fetcher = refusing(["temperature", "reasoning_effort"], completionsAnswer);
    const provider = openai(fetcher);
    expect((await provider.chat({ ...asked, temperature: 0.7, effort: "medium" })).text).toBe("ok");
    const before = fetcher.requests.length;
    await provider.chat({ ...asked, temperature: 0.7, effort: "medium" });
    expect(fetcher.requests).toHaveLength(before + 1);
    expect(fetcher.last().body).not.toHaveProperty("temperature");
    expect(fetcher.last().body).not.toHaveProperty("reasoning_effort");
  });

  test("a 400 the temperature did not cause fails as it would have, and the model keeps getting it", async () => {
    // The failure its caller hears is the one to the request as it was made, not the one to the guard's own second ask.
    const fetcher = fakeFetch((request) =>
      jsonResponse({ error: { message: "temperature" in request.body ? "messages: at least one message is required" : "the second ask's own complaint" } }, 400),
    );
    const provider = openai(fetcher);
    await expect(provider.chat({ ...asked, temperature: 0.7 })).rejects.toThrow(/at least one message/);
    expect(temperatures(fetcher.requests)).toEqual([0.7, undefined]);
    await provider.chat({ ...asked, temperature: 0.7 }).catch(() => {});
    expect(fetcher.requests[2]?.body.temperature).toBe(0.7);
  });

  test("nothing extra without a temperature, or on any failure but a 400", async () => {
    const plain = fakeFetch(jsonResponse({ error: { message: "bad" } }, 400));
    await openai(plain).chat(asked).catch(() => {});
    expect(plain.requests).toHaveLength(1);

    const denied = fakeFetch(jsonResponse({ error: { message: "no access" } }, 403));
    await openai(denied).chat({ ...asked, temperature: 0.7 }).catch(() => {});
    expect(denied.requests).toHaveLength(1);
  });
});
