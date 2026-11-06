/**
 * A voice note on the wire — and the one wire that must refuse it.
 *
 * OpenAI's `input_audio` is the only audio shape either client speaks. Anthropic's Messages API has
 * no audio block, so the Anthropic serializer throws: dropping the part instead is exactly the failure
 * native audio exists to end — a fluent answer about a clip the model never received.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import { toWireMessages } from "../src/anthropic.ts";
import { classifyFailure } from "../src/classify.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { estimateMessageTokens } from "../src/tokens.ts";

async function openaiBody(messages: ChatMessage[]): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const provider = new OpenAIProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    http: {
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    },
  });
  await provider.chat({ model: "m", system: [], messages });
  return captured;
}

const voice = (format: "ogg" | "mp3"): ChatMessage => ({
  role: "user",
  content: [
    { type: "text", text: "what did I say?" },
    { type: "audio", format, data: "T2dnUw==" },
  ],
});

describe("OpenAI", () => {
  test("audio becomes input_audio, in the format it was built in", async () => {
    // `ogg` is passed through as it is: the engine only builds one for a model whose gateway listed
    // it, and a serializer that "corrected" it to mp3 would be sending bytes that are not mp3.
    for (const format of ["ogg", "mp3"] as const) {
      const body = await openaiBody([voice(format)]);
      expect((body.messages as { content: unknown }[])[0]!.content).toEqual([
        { type: "text", text: "what did I say?" },
        { type: "input_audio", input_audio: { data: "T2dnUw==", format } },
      ]);
    }
  });

  test("an unresolved audio_ref is refused, and named", async () => {
    const pending: ChatMessage = {
      role: "user",
      content: [{ type: "audio_ref", ref: "f1", localPath: "/x.ogg", format: "ogg" }],
    };
    expect(openaiBody([pending])).rejects.toThrow("unresolved audio_ref");
  });
});

describe("Anthropic", () => {
  test("refuses audio instead of dropping it", () => {
    expect(() => toWireMessages([voice("ogg")])).toThrow("cannot carry audio");
  });
});

describe("a refused voice note is classified as something the turn can survive", () => {
  test.each([
    // Nougate's own error, from a route that cannot carry audio.
    ["input_audio is not supported by the claudecode provider", 400],
    ["unsupported_content_part", 400],
    // An OpenAI-compatible server refusing a format or the modality.
    ["Invalid value: 'ogg'. Supported values are: 'wav' and 'mp3'. param: input_audio.format", 400],
    ["This model does not support audio input", 400],
    ["Audio input modality is not enabled for this model", 400],
  ])("%s → degrade", (message, status) => {
    const result = classifyFailure({ status, message });
    expect(result.class).toBe("media_unsupported");
    expect(result.action).toBe("degrade");
  });

  test("a plain malformed request is still a bug in our mapping, not a deaf model", () => {
    expect(classifyFailure({ status: 400, message: "invalid_request: malformed JSON" }).class).toBe("request_invalid");
  });
});

describe("audio is costed by length", () => {
  test("a minute-long voice note is not counted as a thousand-token picture", () => {
    const minute: ChatMessage = {
      role: "user",
      content: [{ type: "audio_ref", ref: "f1", localPath: "/x.ogg", format: "ogg", durationSec: 60 }],
    };
    const second: ChatMessage = {
      role: "user",
      content: [{ type: "audio_ref", ref: "f2", localPath: "/y.ogg", format: "ogg", durationSec: 1 }],
    };
    expect(estimateMessageTokens(minute)).toBeGreaterThan(1500);
    expect(estimateMessageTokens(minute)).toBeGreaterThan(estimateMessageTokens(second) * 30);
  });
});
