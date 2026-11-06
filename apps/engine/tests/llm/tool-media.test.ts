/**
 * A tool that opens a picture puts the picture in front of the model.
 *
 * `attachment_read` used to answer with a vision model's prose. That is a lossy transcription
 * standing where the thing itself could stand, and for anything about layout, colour or position it
 * is not merely worse — prose has no coordinates. An agent asked to judge a design got three
 * different descriptions of one screenshot and then wrote a script to count pixels.
 *
 * A tool result is text on the wire, so the picture cannot ride in `content`. The tool names the file
 * on `ToolResult.media` and the executor turns it into a message. What is pinned here is the part
 * that is easy to get wrong: *where* that message goes. A run of tool results has to stay unbroken —
 * Anthropic merges consecutive results into one user turn, so anything wedged between two of them
 * leaves two user turns back to back, which the API rejects.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, ContentPart, ImageRefPart, LLMProvider, Tool } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const ref = (id: string): ImageRefPart => ({
  type: "image_ref",
  ref: id,
  // Never read: `resolveImages` is what would open it, and nothing in this file gets that far.
  localPath: `/nowhere/${id}.png`,
  mimeType: "image/png",
  filename: `${id}.png`,
});

/**
 * A tool that hands back one picture, or none.
 *
 * `parallelSafe` is a parameter and not a constant, and that is not decoration: it is what decides
 * how many *groups* a batch becomes, and the whole hazard being tested lives between two groups. It
 * was hardcoded true here at first, which put every call in one group and made the multi-group test
 * agree with the bug it was written to catch.
 */
function opener(name: string, media?: ImageRefPart[], parallelSafe = true): Tool {
  return {
    requiresApproval: false,
    parallelSafe,
    definition: { name, description: "opens things", parameters: { type: "object", properties: {} } },
    async execute() {
      return { content: `ran ${name}`, isError: false, ...(media ? { media } : {}) };
    },
  };
}

function toolsetOf(tools: Tool[]): AgentToolset {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    definitions: tools.map((tool) => tool.definition),
    get: (name: string) => byName.get(name),
    requiresApproval: () => false,
    parallelSafe: (name: string) => byName.get(name)?.parallelSafe === true,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as AgentToolset;
}

/** Answers one batch of the given calls, then a final message. */
function provider(calls: { id: string; name: string }[]): LLMProvider {
  let asked = 0;
  return {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(): Promise<ChatResponse> {
      asked += 1;
      const base = { usage: { inputTokens: 1, outputTokens: 1 }, model: "gpt-4" };
      if (asked === 1) {
        return {
          text: "",
          toolCalls: calls.map((call) => ({ ...call, arguments: {} })),
          stopReason: "tool_calls",
          ...base,
        } as ChatResponse;
      }
      return { text: "done", toolCalls: [], stopReason: "stop", ...base } as ChatResponse;
    },
  } as unknown as LLMProvider;
}

const executor = () =>
  new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: {
        maxContextRatio: 0.8,
        truncationStrategy: "sliding_window",
        preserveRecentTurns: 1,
        summaryModel: undefined,
        compactAtRatio: 0.9,
        preserveRecentToolResults: 3,
      },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });

const request = (llm: LLMProvider, toolset: AgentToolset) => ({
  agent: fakeAgent(),
  provider: llm,
  toolset,
  history: [],
  userMessage: { role: "user" as const, content: "look at these", timestamp: 1 },
  gateway: "telegram" as const,
  gatewayId: "telegram:main",
  chatId: "chat-1",
  chatType: "dm" as const,
  sessionId: "s1",
  senderId: "u1",
});

/** Every message role in order, so the shape of the round is one assertion. */
const roles = (messages: { role: string }[]) => messages.map((message) => message.role);

const partsOf = (content: unknown): ContentPart[] =>
  Array.isArray(content) ? (content as ContentPart[]) : [];

describe("a tool that opens a picture", () => {
  test("the picture arrives as a message, after the tool result", async () => {
    const result = await executor().run(
      request(
        provider([{ id: "c1", name: "attachment_read" }]),
        toolsetOf([opener("attachment_read", [ref("f1")])]),
      ),
    );

    expect(roles(result.messages)).toEqual(["user", "assistant", "tool", "user", "assistant"]);

    const carried = result.messages.at(-2)!;
    const parts = partsOf(carried.content);
    // A ref, not bytes: the transcript stores a pointer and `resolveImages` reads it for the one
    // request that needs it. Storing base64 here would put a megabyte in the session row.
    expect(parts.filter((part) => part.type === "image_ref")).toEqual([ref("f1")]);
    // Labelled, because a `user` message nobody said has to be tellable from one somebody did.
    expect(parts.find((part) => part.type === "text")?.text).toContain("[harness]");
    // It stays after its pictures leave a request for newer ones, so it says nothing that stops being true then. Live
    // (0.8.12): "You are looking at them now", above lines where the pictures had been, made an agent decide four stills
    // it had read never reached it, and take back what it wrote about them.
    const said = parts.find((part) => part.type === "text")?.text ?? "";
    expect(said).not.toContain("You are looking at them now");
    expect(said).toContain("If a later request cannot carry them all, a line says so where one was left out");
  });

  test("a tool that opens nothing adds no message at all", async () => {
    // The overwhelmingly common turn. An empty picture message every round would be pure cost, and a
    // `user` turn appearing from nowhere is the kind of thing that teaches a model to answer it.
    const result = await executor().run(
      request(provider([{ id: "c1", name: "exec" }]), toolsetOf([opener("exec")])),
    );

    expect(roles(result.messages)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

describe("several calls in one round", () => {
  test("one message for the round, never one per group", async () => {
    /**
     * The hazard this exists for. `attachment_read` is parallel-safe and `exec` is not, so this batch
     * is two groups — and a picture message pushed per group would sit between the two runs of tool
     * results. Anthropic merges consecutive results into one user turn, so that split leaves two user
     * turns back to back and the request is rejected.
     */
    const result = await executor().run(
      request(
        provider([
          { id: "c1", name: "attachment_read" },
          { id: "c2", name: "exec" },
          { id: "c3", name: "attachment_read" },
        ]),
        toolsetOf([opener("attachment_read", [ref("f1")]), opener("exec", undefined, false)]),
      ),
    );

    // Every result first, then one message carrying both pictures.
    expect(roles(result.messages)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);

    const parts = partsOf(result.messages.at(-2)!.content);
    expect(parts.filter((part) => part.type === "image_ref")).toHaveLength(2);
  });
});

describe("a turn that ends on the call that opened the file", () => {
  test("the picture is in front of the model when it writes the answer", async () => {
    /**
     * `wrap_up` ends the turn from inside the tool loop. The picture has to be pushed before that
     * check, or the one turn that most needs it — open the screenshot, then answer about it — writes
     * its reply having never seen it.
     */
    const finisher: Tool = {
      requiresApproval: false,
      definition: { name: "open_and_finish", description: "x", parameters: { type: "object", properties: {} } },
      async execute() {
        return {
          content: "opened it",
          isError: false,
          media: [ref("f9")],
          metadata: { control: { finishTurn: "wrap_up", note: "background_started" } },
        };
      },
    };

    // What the wrap-up request itself was sent, which is the only thing that settles it: the message
    // list is what the model reads, and asserting on the transcript afterwards would pass even if the
    // picture had been appended a step too late.
    const seen: string[] = [];
    let asked = 0;
    const capture = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(params: { messages: { content: unknown }[] }): Promise<ChatResponse> {
        asked += 1;
        const base = { usage: { inputTokens: 1, outputTokens: 1 }, model: "gpt-4" };
        if (asked > 1) {
          seen.push(JSON.stringify(params.messages));
          return { text: "done", toolCalls: [], stopReason: "stop", ...base } as ChatResponse;
        }
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "open_and_finish", arguments: {} }],
          stopReason: "tool_calls",
          ...base,
        } as ChatResponse;
      },
    } as unknown as LLMProvider;

    await executor().run(request(capture, toolsetOf([finisher])));

    expect(seen).not.toHaveLength(0);
    // `resolveImages` cannot open this path, so it collapses to the line that names the ref — which
    // is still proof the message was in the list the wrap-up call was built from.
    expect(seen[0]).toContain("f9");
  });
});
