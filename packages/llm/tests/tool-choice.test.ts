/**
 * Tools offered and not to be called (`ChatParams.toolChoice: "none"`): a turn's last word keeps the tools — and the
 * cached prefix they open — in its request. Each wire says it its own way, and only where there are tools to say it of.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.ts";

const tools = [{ name: "web_search", description: "search", parameters: { type: "object" } }];
const asked = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("tools offered and not to be called", () => {
  test("Anthropic: `tool_choice: {type: none}` beside the tools; nothing without tools, or without the ask", async () => {
    const answer = () => jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const fetcher = fakeFetch(() => answer());
    const provider = new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    await provider.chat({ ...asked, tools, toolChoice: "none" });
    expect(fetcher.last().body.tool_choice).toEqual({ type: "none" });
    expect(fetcher.last().body.tools).toHaveLength(1);
    await provider.chat({ ...asked, toolChoice: "none" });
    expect(fetcher.last().body.tool_choice).toBeUndefined();
    await provider.chat({ ...asked, tools });
    expect(fetcher.last().body.tool_choice).toBeUndefined();
  });

  test("OpenAI-compatible: `tool_choice: \"none\"`", async () => {
    const fetcher = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const provider = new OpenAIProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
    await provider.chat({ ...asked, tools, toolChoice: "none" });
    expect(fetcher.last().body.tool_choice).toBe("none");
    await provider.chat({ ...asked, tools });
    expect(fetcher.last().body.tool_choice).toBeUndefined();
  });
});
