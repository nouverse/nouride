/**
 * A stream that dies part-way through has a name now.
 *
 * `postJson` covers the request — a refused connection, a 503, a socket closed before the headers.
 * It cannot cover what happens after it returns, and that is a real failure with its own shape: the
 * model was answering and the socket went away. It surfaced as bun's bare
 * `TypeError: The socket connection was closed unexpectedly`, which is not an `LLMError`, so the
 * chat got "Something went wrong on my side." — a sentence that names nothing and suggests nothing.
 *
 * Seen live on 2026-09-17: six steps, seventy-nine seconds, and that line.
 */

import { describe, expect, test } from "bun:test";
import { LLMError, type SseEvent } from "@nouride/shared";
import { AnthropicProvider } from "../src/anthropic.ts";
import { cutOff, streamEvents } from "../src/http.ts";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch, jsonResponse, noSleep, sseResponse } from "./helpers.ts";

/** A body that yields `chunks` and then fails the way a dropped socket does. */
function dying(chunks: string[], error: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
        return;
      }
      controller.error(error);
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, idleMs?: number): Promise<SseEvent[]> {
  const seen: SseEvent[] = [];
  for await (const event of streamEvents(stream, idleMs)) seen.push(event);
  return seen;
}

describe("a socket that drops mid-reply", () => {
  const dropped = new TypeError(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  );

  test("becomes an LLMError instead of a bare TypeError", async () => {
    await expect(drain(dying(["data: {}\n\n"], dropped))).rejects.toBeInstanceOf(LLMError);
  });

  test("says what happened and what to do, not 'something went wrong'", async () => {
    // The whole point. The old line named no cause and offered no next step, so the person asked the
    // agent what had happened — and the agent guessed.
    try {
      await drain(dying(["data: {}\n\n"], dropped));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      const message = (err as LLMError).userMessage;
      expect(message).toContain("dropped part-way through");
      expect(message).toContain("Send that again");
      expect(message).not.toContain("Something went wrong");
    }
  });

  test("is classified a passing failure, so a fallback can answer a reply that had not begun — and one that just ends", async () => {
    const failed = await drain(dying([], dropped)).catch((err: unknown) => err);
    expect((failed as LLMError).failure).toMatchObject({ class: "transient", action: "retry", alertOperator: false });
    expect(cutOff().failure).toMatchObject({ class: "transient", action: "retry", alertOperator: false });
  });

  test("the log keeps the original, so the cause is still findable", async () => {
    try {
      await drain(dying([], dropped));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as LLMError).message).toContain("socket connection was closed");
      expect((err as LLMError).cause).toBe(dropped);
    }
  });

  test("events that arrived before the drop are still delivered", async () => {
    // A stream is consumed as it arrives, and whatever was parsed before the failure is real. Losing
    // it would turn one dropped connection into a turn that also forgot what it had been told.
    const seen: SseEvent[] = [];
    try {
      for await (const event of streamEvents(dying(["data: a\n\n", "data: b\n\n"], dropped))) {
        seen.push(event);
      }
    } catch {
      // expected
    }
    expect(seen.map((event) => event.data)).toEqual(["a", "b"]);
  });
});

describe("a stream that goes quiet", () => {
  test("is told apart from one that dropped, because the fix is different", async () => {
    // Nothing is wrong with the connection; the provider simply stopped sending. Saying "dropped"
    // there would send somebody looking at their network.
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\n"));
      },
      pull() {
        // Never resolves: the watchdog is what ends this.
        return new Promise<void>(() => {});
      },
    });

    try {
      await drain(stalling, 30);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).userMessage).toContain("never resumed");
      expect((err as LLMError).message).toContain("stream stalled");
    }
  });
});

describe("failures that were already ours", () => {
  test("keep their own reason rather than being relabelled", async () => {
    // An abort is a decision, not a dropped connection, and it already carries the right message.
    const mine = new LLMError("request aborted");
    await expect(drain(dying([], mine))).rejects.toBe(mine);
  });
});

/**
 * A failure the provider names in an answer that began as a 200 (nouride-releases#14).
 *
 * A gateway in front of Codex reported its upstream's failure as nothing at all, and one that does report it does so as
 * an `error` in the stream — which this client read past: an empty answer, "I did not manage to produce an answer" on
 * every message, and no fallback, no shorter request, nothing in the log saying why.
 */
describe("a failure named inside the answer", () => {
  const openai = (response: Response) => new OpenAIProvider({ baseUrl: "https://gw.example/v1", apiKey: "sk-test", http: { fetchImpl: fakeFetch(response).fn, sleep: noSleep } });
  const failure = async (run: () => Promise<unknown>): Promise<LLMError> => {
    const err = await run().then(() => null, (thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(LLMError);
    return err as LLMError;
  };
  const drainChat = async (stream: AsyncIterable<unknown>) => {
    for await (const _ of stream) void _;
  };

  test("an `error` in an OpenAI stream is that failure, classified — a window overflow shrinks the request", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"error":{"message":"Your input exceeds the context window of this model.","code":"context_length_exceeded"}}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const err = await failure(() => drainChat(openai(res).stream({ model: "codex:gpt-5.6-luna", messages: [] })));
    expect(err.failure).toMatchObject({ class: "context_overflow", action: "shrink" });
    // The provider's own words reach the log, for the operator to read.
    expect(err.message).toContain("context_length_exceeded: Your input exceeds the context window");
  });

  test("OpenRouter's shape — a status in `code`, beside `finish_reason: error` — is a passing failure a fallback answers", async () => {
    const res = sseResponse([
      'data: {"error":{"code":502,"message":"Provider disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
    ]);
    const err = await failure(() => drainChat(openai(res).stream({ model: "m", messages: [] })));
    expect(err.status).toBe(502);
    expect(err.failure).toMatchObject({ class: "transient", action: "retry" });
    expect(err.userMessage).toBe("The model is not responding right now. Try again shortly.");
  });

  test("a 200 body holding an `error` is that error, not an answer this client could not read", async () => {
    const res = jsonResponse({ error: { message: "Rate limit reached for gpt-5.6-luna.", type: "rate_limit_exceeded" } });
    const err = await failure(() => openai(res).chat({ model: "m", messages: [] }));
    expect(err.failure).toMatchObject({ class: "rate_limit", action: "retry" });
  });

  test("Anthropic's `error` event is classified too: an overload is retried, not 'something went wrong'", async () => {
    const res = sseResponse(['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']);
    const provider = new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-test", http: { fetchImpl: fakeFetch(res).fn, sleep: noSleep } });
    const err = await failure(() => drainChat(provider.stream({ model: "claude-sonnet-4-6", messages: [] })));
    expect(err.failure).toMatchObject({ class: "overloaded", action: "retry" });
    expect(err.message).toContain("overloaded_error: Overloaded");
  });
});
