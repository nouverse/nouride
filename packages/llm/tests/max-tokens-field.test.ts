/**
 * Which field a reply's output limit goes in on the OpenAI wire: the one the profile names.
 *
 * A Community user on OpenAI's own API with a GPT-5-family model had every reply and every compaction refused:
 * `400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`
 * The client always sent `max_tokens`. A server that only speaks the format may know nothing else, so the field is a
 * profile's (`maxTokensField`), never a guess from the model or the address.
 */

import { describe, expect, test } from "bun:test";
import type { MaxTokensField, StreamChunk } from "@nouride/shared";
import { createProvider } from "../src/index.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const asked = { model: "gpt-5-mini", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 32_000 };
const answer = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

function client(fetchImpl: typeof fetch, maxTokensField?: MaxTokensField) {
  return createProvider({ kind: "openai", baseUrl: "https://api.test/v1", apiKey: "k", ...(maxTokensField ? { maxTokensField } : {}), http: { fetchImpl, sleep: noSleep } });
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _ of stream) void _;
}

describe("the output limit's field", () => {
  test("a profile that says max_completion_tokens: the limit goes there, and max_tokens is not sent", async () => {
    const fetcher = fakeFetch(answer());
    await client(fetcher.fn, "max_completion_tokens").chat(asked);
    expect(fetcher.last().body.max_completion_tokens).toBe(32_000);
    expect(fetcher.last().body).not.toHaveProperty("max_tokens");
  });

  test("streamed too: the same request builder, the same field", async () => {
    const fetcher = fakeFetch(
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"]),
    );
    await drain(client(fetcher.fn, "max_completion_tokens").stream(asked));
    expect(fetcher.last().body.max_completion_tokens).toBe(32_000);
    expect(fetcher.last().body).not.toHaveProperty("max_tokens");
  });

  test("a profile that says nothing, or max_tokens: max_tokens, as every OpenAI-shaped server reads it", async () => {
    for (const field of [undefined, "max_tokens"] as const) {
      const fetcher = fakeFetch(answer());
      await client(fetcher.fn, field).chat(asked);
      expect(fetcher.last().body.max_tokens).toBe(32_000);
      expect(fetcher.last().body).not.toHaveProperty("max_completion_tokens");
    }
  });

  test("no limit asked: neither field", async () => {
    const fetcher = fakeFetch(answer());
    await client(fetcher.fn, "max_completion_tokens").chat({ model: "gpt-5-mini", messages: asked.messages });
    expect(fetcher.last().body).not.toHaveProperty("max_tokens");
    expect(fetcher.last().body).not.toHaveProperty("max_completion_tokens");
  });

  test("the Anthropic wire has the one field, whatever a spec carries", async () => {
    const fetcher = fakeFetch(
      jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    await createProvider({ kind: "anthropic", baseUrl: "https://api.test/v1", apiKey: "k", maxTokensField: "max_completion_tokens", http: { fetchImpl: fetcher.fn, sleep: noSleep } }).chat(asked);
    expect(fetcher.last().body.max_tokens).toBe(32_000);
    expect(fetcher.last().body).not.toHaveProperty("max_completion_tokens");
  });
});
