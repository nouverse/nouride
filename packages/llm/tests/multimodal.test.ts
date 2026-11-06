/**
 * An image on the wire, in each provider's own spelling.
 *
 * The two formats differ for the same capability — OpenAI takes a `data:` URL under `image_url`,
 * Anthropic takes raw base64 under `source` — which is exactly the kind of difference
 * `ProviderKind` exists to keep out of the engine. Nothing above these files knows either.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import { toWireMessages } from "../src/anthropic.ts";
import { OpenAIProvider } from "../src/openai.ts";

const PIXEL = "iVBORw0KGgo=";

/** The OpenAI client has no exported serializer, so the wire body is read off a captured request. */
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

describe("OpenAI", () => {
  test("an image becomes a data URL beside the text", async () => {
    const body = await openaiBody([
      {
        role: "user",
        content: [
          { type: "text", text: "what overlaps here?" },
          { type: "image", mimeType: "image/png", data: PIXEL },
        ],
      },
    ]);

    const message = (body.messages as { content: unknown }[])[0]!;
    expect(message.content).toEqual([
      { type: "text", text: "what overlaps here?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}`, detail: "auto" } },
    ]);
  });

  test("text-only content stays a plain string", async () => {
    /**
     * Not cosmetic. A one-element parts array changes the bytes of every request — which the
     * implicit prefix caches these endpoints run on can see — and several OpenAI-compatible
     * servers handle the two shapes differently.
     */
    const body = await openaiBody([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect((body.messages as { content: unknown }[])[0]!.content).toBe("hello");
  });

  test("an assistant turn with only tool calls still sends null, not a list", async () => {
    const body = await openaiBody([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: {} }] },
    ]);
    expect((body.messages as { content: unknown }[])[1]!.content).toBeNull();
  });

  test("an unresolved ref is refused rather than sent as a path", async () => {
    /**
     * The failure this prevents is not an error — it is an *answer*. A model handed
     * `/srv/nouride/.../IMG_0016.png` describes a file path fluently and at length, and nothing in
     * the reply shows that it never saw the picture.
     */
    await expect(
      openaiBody([
        {
          role: "user",
          content: [{ type: "image_ref", ref: "r", localPath: "/tmp/x.png", mimeType: "image/png" }],
        },
      ]),
    ).rejects.toThrow(/unresolved image_ref/);
  });
});

describe("Anthropic", () => {
  test("an image becomes a base64 source block", () => {
    const [message] = toWireMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what overlaps here?" },
          { type: "image", mimeType: "image/png", data: PIXEL },
        ],
      },
    ]);

    expect(message?.content).toEqual([
      { type: "text", text: "what overlaps here?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
    ]);
  });

  test("an empty text part produces no block", () => {
    // A message with no content at all is rejected by the API, and the caller drops it — which is
    // only correct if "" comes back as nothing rather than as an empty text block.
    const out = toWireMessages([{ role: "user", content: [{ type: "text", text: "" }] }]);
    expect(out).toEqual([]);
  });

  test("an unresolved ref is refused", () => {
    expect(() =>
      toWireMessages([
        {
          role: "user",
          content: [{ type: "image_ref", ref: "r", localPath: "/tmp/x.png", mimeType: "image/png" }],
        },
      ]),
    ).toThrow(/unresolved image_ref/);
  });

  test("tool results keep working when content is parts", () => {
    const out = toWireMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: {} }] },
      { role: "tool", content: "file contents", toolCallId: "c1" },
    ]);
    expect(out.at(-1)?.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "file contents" },
    ]);
  });
});

/**
 * A picture handed back by a tool.
 *
 * A tool result is text on the wire — OpenAI's `tool` role takes a string and nothing else — so a
 * tool that opens an image cannot return it through its own result. The executor puts the picture in
 * a `user` message immediately after the `tool` messages of the same round, and each provider has to
 * be given the shape it accepts for that.
 */
describe("a user message that follows tool results", () => {
  const afterTools: ChatMessage[] = [
    { role: "user", content: "what is in that screenshot?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "attachment_read", arguments: { ref: "f1" } },
        { id: "c2", name: "attachment_read", arguments: { ref: "f2" } },
      ],
    },
    { role: "tool", content: "Opened a.png.", toolCallId: "c1" },
    { role: "tool", content: "Opened b.png.", toolCallId: "c2" },
    {
      role: "user",
      content: [
        { type: "text", text: "[harness] the files you opened are below" },
        { type: "image", mimeType: "image/png", data: PIXEL },
      ],
    },
  ];

  test("Anthropic folds it into the turn holding the results, not a second user turn", () => {
    // Consecutive same-role turns are not a shape this API accepts, and a run of tool results
    // already merges into one user turn — so a picture behind them would be the second.
    const wire = toWireMessages(afterTools);
    const roles = wire.map((message) => message.role);

    expect(roles).toEqual(["user", "assistant", "user"]);

    const last = wire.at(-1)!;
    // Results first, then the picture: the order this API documents for a turn that carries both.
    expect(last.content.map((block) => block.type)).toEqual([
      "tool_result",
      "tool_result",
      "text",
      "image",
    ]);
  });

  test("a person speaking between two results is still a turn of its own", () => {
    // The fold is for a message that carries a picture, not for every user message that lands behind
    // a result. Role alone cannot tell a harness-authored picture from somebody talking; carrying an
    // image can, and widening it to role swallowed a person mid-conversation.
    const wire = toWireMessages([
      { role: "tool", content: "a", toolCallId: "c1" },
      { role: "user", content: "and now?" },
      { role: "tool", content: "b", toolCallId: "c2" },
    ]);

    expect(wire).toHaveLength(3);
  });

  test("OpenAI sends it as its own message, which is valid after a tool message", async () => {
    const body = await openaiBody(afterTools);
    const messages = body.messages as { role: string }[];

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
  });
});
