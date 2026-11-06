/**
 * A reply cut at the output limit while it was writing a tool call (2026-10-21, turn 44d1bdd4): the stop reason says
 * `tool_calls`, so the engine could not tell the model why its arguments arrived half-written. `cutAtLimit` says it, on
 * both wire formats and both paths. And the cap itself is the model's own, not a flat 8192 (`outputLimitInfo`).
 */

import { describe, expect, test } from "bun:test";
import type { StreamChunk } from "@nouride/shared";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { outputLimitInfo } from "../src/output-limits.ts";
import { toolArguments } from "../src/tool-arguments.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

const openai = (fetchImpl: typeof fetch) => new OpenAIProvider({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", http: { fetchImpl, sleep: noSleep } });
const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-test", http: { fetchImpl, sleep: noSleep } });

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("a reply stopped at the output limit says so, tool calls or not", () => {
  test("OpenAI streamed: finish_reason length with a half-written call", async () => {
    const chunks = await drain(
      openai(
        fakeFetch(
          sseResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write","arguments":"{\\"path\\":\\"a.md\\",\\"content\\":\\"long"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        ).fn,
      ).stream({ model: "claude-sonnet-5-5", messages: [] }),
    );
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "tool_calls", cutAtLimit: true });
    const call = chunks.find((chunk) => chunk.type === "tool_call");
    expect(call?.type === "tool_call" && call.call.argumentsError?.reason).toMatch(/not valid JSON/);
  });

  test("OpenAI whole: finish_reason length", async () => {
    const res = await openai(fakeFetch(jsonResponse({ choices: [{ message: { content: "half a" }, finish_reason: "length" }] })).fn).chat({ model: "gpt-5", messages: [] });
    expect(res.cutAtLimit).toBe(true);
    expect(res.stopReason).toBe("max_tokens");
  });

  test("an ordinary finish carries no flag", async () => {
    const res = await openai(fakeFetch(jsonResponse({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] })).fn).chat({ model: "gpt-5", messages: [] });
    expect(res).not.toHaveProperty("cutAtLimit");
  });

  test("Anthropic streamed: stop_reason max_tokens during a tool_use", async () => {
    const chunks = await drain(
      anthropic(
        fakeFetch(
          sseResponse([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write"}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a"}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
          ]),
        ).fn,
      ).stream({ model: "claude-sonnet-4-6", messages: [] }),
    );
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "tool_calls", cutAtLimit: true });
  });

  test("Anthropic whole: stop_reason max_tokens", async () => {
    const res = await anthropic(fakeFetch(jsonResponse({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" })).fn).chat({ model: "claude-opus-4-1", messages: [] });
    expect(res.cutAtLimit).toBe(true);
  });
});

describe("outputLimitInfo", () => {
  test("the families the table names, behind a routing prefix too", () => {
    for (const model of ["claude-sonnet-5-5", "nougate:claude-sonnet-5-5", "claude-opus-4-1", "anthropic/claude-haiku-4-5", "gemini-3-flash", "antigravity:gemini-2.5-pro", "gpt-5", "gpt-5.1-codex"]) {
      expect(outputLimitInfo(model)).toEqual({ tokens: 32_000, known: true });
    }
  });

  test("what it cannot vouch for keeps 8192 — a smaller sibling under a matching name included", () => {
    for (const model of ["claude-3-5-haiku", "gemini-2.0-flash", "gpt-5-chat-latest", "gpt-4o", "llama-4-maverick", "mystery"]) {
      expect(outputLimitInfo(model)).toEqual({ tokens: 8192, known: false });
    }
  });
});

describe("unreadable arguments are kept, capped", () => {
  test("the first 2 KB of what arrived, not the whole document", () => {
    const raw = `{"path":"a.md","content":"${"x".repeat(10_000)}`;
    const parsed = toolArguments(raw);
    expect(parsed.arguments).toEqual({});
    expect(parsed.argumentsError?.raw).toBe(raw.slice(0, 2048));
  });
});
