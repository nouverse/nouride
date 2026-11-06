import { describe, expect, test } from "bun:test";
import type { ChatMessage, StreamChunk } from "@nouride/shared";
import { AnthropicProvider, toSystemBlocks, toWireMessages } from "../src/anthropic.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

function provider(fetchImpl: typeof fetch) {
  return new AnthropicProvider({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-test",
    http: { fetchImpl, sleep: noSleep },
  });
}

describe("toWireMessages", () => {
  test("hoists text into a content block", () => {
    expect(toWireMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("drops system messages — they belong in the top-level field", () => {
    expect(toWireMessages([{ role: "system", content: "be nice" }])).toEqual([]);
  });

  test("merges consecutive tool results into one user message", () => {
    // The API rejects one user message per tool_result with an "unexpected role"
    // error, so this merge is a correctness requirement, not a tidiness one.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "read", arguments: {} },
          { id: "c2", name: "read", arguments: {} },
        ],
      },
      { role: "tool", content: "first", toolCallId: "c1" },
      { role: "tool", content: "second", toolCallId: "c2" },
    ];

    const wire = toWireMessages(messages);
    expect(wire).toHaveLength(2);
    expect(wire[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "first" },
        { type: "tool_result", tool_use_id: "c2", content: "second" },
      ],
    });
  });

  test("starts a new user message when a real user turn separates tool results", () => {
    const wire = toWireMessages([
      { role: "tool", content: "a", toolCallId: "c1" },
      { role: "user", content: "and now?" },
      { role: "tool", content: "b", toolCallId: "c2" },
    ]);
    expect(wire).toHaveLength(3);
  });

  test("emits text and tool_use blocks together for one assistant turn", () => {
    const wire = toWireMessages([
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }],
      },
    ]);
    expect(wire[0]?.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "c1", name: "read", input: { path: "a" } },
    ]);
  });

  test("drops an entirely empty message rather than sending a stub", () => {
    expect(toWireMessages([{ role: "assistant", content: "" }])).toEqual([]);
  });
});

describe("toSystemBlocks", () => {
  test("a single uncached block goes out as a plain string", () => {
    // The format Anthropic has always accepted, and the only one older proxies are guaranteed to
    // pass through. Nothing is gained by wrapping one uncacheable block in an array.
    expect(toSystemBlocks("You are a helpful assistant.")).toBe("You are a helpful assistant.");
    expect(toSystemBlocks([{ text: "You are a helpful assistant." }])).toBe(
      "You are a helpful assistant.",
    );
  });

  test("no system prompt at all is undefined, not an empty block", () => {
    // An empty text block is a 400 — "text content blocks must be non-empty" — so the field has to
    // be absent rather than present and empty.
    expect(toSystemBlocks(undefined)).toBeUndefined();
    expect(toSystemBlocks("")).toBeUndefined();
    expect(toSystemBlocks([{ text: "", cache: true }])).toBeUndefined();
  });

  test("each block marked `cache` gets its own breakpoint", () => {
    expect(
      toSystemBlocks([
        { text: "from the pack", cache: true },
        { text: "from the toolset", cache: true },
        { text: "it is Tuesday" },
      ]),
    ).toEqual([
      { type: "text", text: "from the pack", cache_control: { type: "ephemeral" } },
      { type: "text", text: "from the toolset", cache_control: { type: "ephemeral" } },
      { type: "text", text: "it is Tuesday" },
    ]);
  });

  test("a lone cached block keeps its breakpoint rather than collapsing to a string", () => {
    // Dropping the marker here would silently turn caching off for a prompt that asked for it.
    expect(toSystemBlocks([{ text: "You are Nouva.", cache: true }])).toEqual([
      { type: "text", text: "You are Nouva.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("empty blocks are dropped, not sent", () => {
    expect(
      toSystemBlocks([{ text: "kept", cache: true }, { text: "" }, { text: "also kept" }]),
    ).toEqual([
      { type: "text", text: "kept", cache_control: { type: "ephemeral" } },
      { type: "text", text: "also kept" },
    ]);
  });

  test("breakpoints past the budget are dropped rather than sent as a 400", () => {
    const blocks = toSystemBlocks(
      [
        { text: "one", cache: true },
        { text: "two", cache: true },
        { text: "three", cache: true },
        { text: "tail" },
      ],
      2,
    ) as { cache_control?: unknown }[];

    expect(blocks.filter((block) => block.cache_control)).toHaveLength(2);
  });
});

describe("streaming", () => {
  test("a request that does not stream says so — a proxy that defaults to streaming sees `false`, not nothing", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({ model: "claude", messages: [{ role: "user", content: "hello" }] });
    expect(fetcher.last().body.stream).toBe(false);
  });
});

describe("the conversation carries a cache breakpoint too", () => {
  test("the marker sits on the last content block of the last message", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });

    const messages = fetcher.last().body.messages as {
      content: { text?: string; cache_control?: unknown }[];
    }[];

    // Only the tail — earlier blocks are covered by the entry this one writes.
    expect(messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined();
    expect(messages[1]!.content[0]!.cache_control).toBeUndefined();
  });

  test("it lands on a tool result when that is what the turn ends with", async () => {
    // The shape every tool iteration actually sends: the loop's last message is a user message full
    // of tool_result blocks, and that is where the growing conversation ends.
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "read both files" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "a", name: "read", arguments: { path: "one" } },
            { id: "b", name: "read", arguments: { path: "two" } },
          ],
        },
        { role: "tool", content: "one", toolCallId: "a" },
        { role: "tool", content: "two", toolCallId: "b" },
      ],
    });

    const messages = fetcher.last().body.messages as {
      content: { type: string; cache_control?: unknown }[];
    }[];
    const last = messages.at(-1)!.content;

    expect(last.map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
    expect(last.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(last[0]!.cache_control).toBeUndefined();
  });

  test("the budget is shared with the system blocks, and the system claims it first", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      // Four is the API's ceiling; a fifth marker is a 400 that fails the whole turn.
      system: [
        { text: "one", cache: true },
        { text: "two", cache: true },
        { text: "three", cache: true },
        { text: "four", cache: true },
        { text: "tail" },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const body = fetcher.last().body as {
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };

    expect(body.system.filter((block) => block.cache_control)).toHaveLength(4);
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined();
  });

  test("the prompt's three cached blocks and the conversation's marker are the four the API takes", async () => {
    // The shape Nouride sends since M2: the pack, the harness and the recall each cached, the request tier not.
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      system: [
        { text: "the pack", cache: true },
        { text: "the harness", cache: true },
        { text: "what is recalled", cache: true },
        { text: "today, and who is speaking" },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const body = fetcher.last().body as {
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };

    expect(body.system.map((block) => Boolean(block.cache_control))).toEqual([true, true, true, false]);
    expect(body.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("the tail goes after the breakpoint, so the next step still reads everything before it", async () => {
    // The work notes (0.7.26) change between steps. Under the marker, the next step — where they have moved past a tool
    // result — would miss the whole turn so far.
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "check the documents" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: { path: "one" } }] },
        { role: "tool", content: "one", toolCallId: "a" },
      ],
      tail: "NOTES\n## Verify 52 documents\n- Done: 1–30",
    });

    const last = (fetcher.last().body.messages as { content: { type: string; text?: string; cache_control?: unknown }[] }[]).at(-1)!.content;
    expect(last.map((block) => block.type)).toEqual(["tool_result", "text"]);
    expect(last[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(last[1]).toEqual({ type: "text", text: "NOTES\n## Verify 52 documents\n- Done: 1–30" });
  });

  test("after an assistant's turn, the tail is a user turn of its own", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      tail: "NOTES",
    });
    const messages = fetcher.last().body.messages as { role: string; content: { type?: string; text?: string; cache_control?: unknown }[] }[];
    expect(messages.at(-2)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "NOTES" }] });
  });

  test("no messages is not a crash", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({ model: "claude-sonnet-4-20250514", messages: [] });

    expect(fetcher.last().body.messages).toEqual([]);
  });
});

describe("AnthropicProvider.chat", () => {
  test("sends system top-level with the version header and required max_tokens", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      system: "you are a bot",
      messages: [{ role: "user", content: "hello" }],
    });

    const req = fetcher.last();
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-test");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body.system).toBe("you are a bot");
    // Unlike OpenAI, max_tokens is mandatory — a request without it is a 400.
    expect(req.body.max_tokens).toBe(4096);
  });

  test("joins multiple text blocks and reads usage", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    );
    const res = await provider(fetcher.fn).chat({ model: "claude-sonnet-4-20250514", messages: [] });

    expect(res.text).toBe("part one part two");
    expect(res.stopReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 5, estimated: false, attempts: 1, latencyMs: expect.any(Number), stopReason: "stop" });
  });

  test("extracts tool_use blocks", async () => {
    const fetcher = fakeFetch(
      jsonResponse({
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "exec", input: { cmd: "ls" } },
        ],
        stop_reason: "tool_use",
      }),
    );
    const res = await provider(fetcher.fn).chat({ model: "claude-sonnet-4-20250514", messages: [] });

    expect(res.text).toBe("checking");
    expect(res.stopReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "exec", arguments: { cmd: "ls" } }]);
  });

  test("maps tool definitions to input_schema", async () => {
    const fetcher = fakeFetch(jsonResponse({ content: [] }));
    await provider(fetcher.fn).chat({
      model: "claude-sonnet-4-20250514",
      messages: [],
      tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
    });

    expect(fetcher.last().body.tools).toEqual([
      { name: "read", description: "read a file", input_schema: { type: "object" } },
    ]);
  });

  test("reports max_tokens truncation", async () => {
    const fetcher = fakeFetch(
      jsonResponse({ content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" }),
    );
    const res = await provider(fetcher.fn).chat({ model: "claude-sonnet-4-20250514", messages: [] });
    expect(res.stopReason).toBe("max_tokens");
  });
});

describe("AnthropicProvider.stream", () => {
  async function drain(chunks: AsyncIterable<StreamChunk>) {
    const out: StreamChunk[] = [];
    for await (const chunk of chunks) out.push(chunk);
    return out;
  }

  test("yields text deltas and accumulates usage across events", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const chunks = await drain(
      provider(fetcher.fn).stream({ model: "claude-sonnet-4-20250514", messages: [] }),
    );

    expect(chunks).toEqual([
      { type: "text", delta: "Hi " },
      { type: "text", delta: "there" },
      // input_tokens comes from message_start, output_tokens from message_delta —
      // neither event carries both.
      { type: "usage", usage: { inputTokens: 12, outputTokens: 4, estimated: false, attempts: 1, latencyMs: expect.any(Number), stopReason: "stop" } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  test("assembles a tool call from input_json_delta fragments", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"ls -la\\"}"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      ]),
    );

    const chunks = await drain(
      provider(fetcher.fn).stream({ model: "claude-sonnet-4-20250514", messages: [] }),
    );

    expect(chunks).toContainEqual({
      type: "tool_call",
      call: { id: "toolu_1", name: "exec", arguments: { cmd: "ls -la" } },
    });
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "tool_calls" });
  });

  test("throws on a mid-stream error event", async () => {
    const fetcher = fakeFetch(
      sseResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
      ]),
    );

    const iterate = async () => {
      await drain(provider(fetcher.fn).stream({ model: "claude-sonnet-4-20250514", messages: [] }));
    };
    await expect(iterate()).rejects.toThrow(/stream error/);
  });
});
