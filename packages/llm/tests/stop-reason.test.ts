/**
 * Why a call ended, carried with its usage (`TokenUsage.stopReason`) — what `llm_usage.stop_reason` records (0.7.26).
 *
 * On 2026-10-20/21 "cut at the output limit" was read off output counts that stopped at exactly 8192. The provider had
 * said `length` every time; nothing kept it. These hold the two things that make the column worth reading: a cut reply
 * says `max_tokens` even when it carried a tool call — which `ChatResponse.stopReason` calls `tool_calls` — and a
 * provider that said nothing records nothing, never a guessed `stop`.
 */

import { describe, expect, test } from "bun:test";
import type { StreamChunk, TokenUsage } from "@nouride/shared";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const openai = (fetchImpl: typeof fetch) => new OpenAIProvider({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", http: { fetchImpl, sleep: noSleep } });
const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-test", http: { fetchImpl, sleep: noSleep } });

async function usageOf(stream: AsyncIterable<StreamChunk>): Promise<TokenUsage> {
  let usage: TokenUsage | undefined;
  for await (const chunk of stream) if (chunk.type === "usage") usage = chunk.usage;
  if (!usage) throw new Error("the stream reported no usage");
  return usage;
}

const openaiStream = (...frames: string[]) => usageOf(openai(fakeFetch(sseResponse([...frames, "data: [DONE]\n\n"])).fn).stream({ model: "gpt-5", messages: [] }));
const anthropicStream = (...frames: string[]) => usageOf(anthropic(fakeFetch(sseResponse(frames)).fn).stream({ model: "claude-sonnet-4-6", messages: [] }));

describe("OpenAI-compatible", () => {
  test("streamed: a reply cut while writing a tool call is `max_tokens` on the record, though the turn reads `tool_calls`", async () => {
    const usage = await openaiStream(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write","arguments":"{\\"path\\":\\"a"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    );
    expect(usage.stopReason).toBe("max_tokens");
  });

  test("streamed: each finish reason, normalised — and `error`, a gateway saying generation failed", async () => {
    const said = async (reason: string) => (await openaiStream(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":"${reason}"}]}\n\n`)).stopReason;
    expect(await said("stop")).toBe("stop");
    expect(await said("tool_calls")).toBe("tool_calls");
    expect(await said("error")).toBe("error");
  });

  test("streamed: a stream that ended on `[DONE]` alone, or on a reason none of the four is, records no reason", async () => {
    expect(await openaiStream('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')).not.toHaveProperty("stopReason");
    expect(await openaiStream('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}\n\n')).not.toHaveProperty("stopReason");
  });

  test("whole: the finish reason is on the usage", async () => {
    const res = await openai(fakeFetch(jsonResponse({ choices: [{ message: { content: "half a" }, finish_reason: "length" }] })).fn).chat({ model: "gpt-5", messages: [] });
    expect(res.usage.stopReason).toBe("max_tokens");
    const silent = await openai(fakeFetch(jsonResponse({ choices: [{ message: { content: "done" } }] })).fn).chat({ model: "gpt-5", messages: [] });
    expect(silent.stopReason).toBe("stop");
    expect(silent.usage).not.toHaveProperty("stopReason");
  });
});

describe("Anthropic", () => {
  test("streamed: `max_tokens` during a tool_use is `max_tokens` on the record", async () => {
    const usage = await anthropicStream(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8192}}\n\n',
    );
    expect(usage.stopReason).toBe("max_tokens");
  });

  test("streamed: `end_turn` and `tool_use`, normalised; `message_stop` with no reason records none", async () => {
    const said = async (reason: string) =>
      (await anthropicStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n', `data: {"type":"message_delta","delta":{"stop_reason":"${reason}"}}\n\n`)).stopReason;
    expect(await said("end_turn")).toBe("stop");
    expect(await said("tool_use")).toBe("tool_calls");
    expect(await said("refusal")).toBeUndefined();
    const silent = await anthropicStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_stop"}\n\n');
    expect(silent).not.toHaveProperty("stopReason");
  });

  test("whole: the stop reason is on the usage", async () => {
    const res = await anthropic(fakeFetch(jsonResponse({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" })).fn).chat({ model: "claude-opus-4-1", messages: [] });
    expect(res.usage.stopReason).toBe("max_tokens");
  });
});
