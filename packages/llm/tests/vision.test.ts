/**
 * `describeImage` (`vision.ts`), asked over a provider client: it used to hand-build both vendors' requests, so it
 * missed `stream: false`, failed on a proxy that streams anyway, and returned text alone — the call's usage dropped.
 */

import { describe, expect, test } from "bun:test";
import { LLMError, type ImagePart } from "@nouride/shared";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { describeImage } from "../src/vision.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const IMAGE: ImagePart = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
const http = (response: Response) => ({ fetchImpl: fakeFetch(response).fn, sleep: noSleep });

describe("describing an image", () => {
  test("over the OpenAI wire: the picture and the question in one message, the text and the usage back", async () => {
    const fake = fakeFetch(jsonResponse({ model: "gpt-4o", choices: [{ message: { content: " A chart: sales up 12%. " }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 12 } }));
    const provider = new OpenAIProvider({ baseUrl: "https://api.example.com/v1", apiKey: "k", http: { fetchImpl: fake.fn, sleep: noSleep } });
    const described = await describeImage({ provider, model: "gpt-4o", image: IMAGE, prompt: "what does it say?" });

    expect(described).toMatchObject({ text: "A chart: sales up 12%.", model: "gpt-4o", usage: { inputTokens: 900, outputTokens: 12 } });
    const content = (fake.last().body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((part) => part.type)).toEqual(["image_url", "text"]);
    expect(fake.last().body.stream).toBe(false);
  });

  test("over the Anthropic wire", async () => {
    const provider = new AnthropicProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      http: http(jsonResponse({ model: "claude-haiku-4-5", content: [{ type: "text", text: "A cat." }], stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 3 } })),
    });
    expect(await describeImage({ provider, model: "claude-haiku-4-5", image: IMAGE })).toMatchObject({ text: "A cat.", usage: { inputTokens: 800, outputTokens: 3 } });
  });

  test("an answer a proxy streamed although it was not asked to is read as the stream it is", async () => {
    const provider = new OpenAIProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      http: http(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"A receipt."}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":700,"completion_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    });
    expect(await describeImage({ provider, model: "m", image: IMAGE })).toMatchObject({ text: "A receipt.", usage: { inputTokens: 700, outputTokens: 4 } });
  });

  test("nothing said is a failure, not a blank image", async () => {
    const provider = new OpenAIProvider({ baseUrl: "https://api.example.com/v1", apiKey: "k", http: { ...http(jsonResponse({ choices: [{ message: { content: "  " }, finish_reason: "stop" }] })), maxAttempts: 1 } });
    const failed = await describeImage({ provider, model: "m", image: IMAGE }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(LLMError);
    expect((failed as LLMError).message).toContain("no description");
  });
});
