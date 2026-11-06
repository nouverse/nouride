import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../src/openai.ts";
import { parseSse } from "@nouride/shared";
import { noSleep } from "./helpers.ts";
import { sleep } from "./wait.ts";

/**
 * These pin the failure that cost thirteen minutes of a live daemon: a request with no deadline.
 * The queue is sequential per conversation, so one stalled call blocks every later message in that
 * chat and `pipeline.idle()` never resolves — the daemon looks alive and answers nothing.
 */

describe("request timeout", () => {
  test("gives up when the provider accepts the connection and never answers", async () => {
    let attempts = 0;
    const hanging = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      // Resolves only when aborted — exactly what an unresponsive upstream looks like.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({
      baseUrl: "https://stalled.test/v1",
      apiKey: "k",
      http: { fetchImpl: hanging, sleep: noSleep, timeoutMs: 40, maxAttempts: 2 },
    });

    await expect(
      provider.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/no response within 40ms/);

    // Retried, because a provider that timed out once may answer the next attempt.
    expect(attempts).toBe(2);
  });

  test("a caller's abort is not retried", async () => {
    let attempts = 0;
    const hanging = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const provider = new OpenAIProvider({
      baseUrl: "https://stalled.test/v1",
      apiKey: "k",
      http: { fetchImpl: hanging, sleep: noSleep, timeoutMs: 5_000, maxAttempts: 3 },
    });

    const promise = provider.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    controller.abort();

    // Cancelling a turn is a decision, not a transient failure to retry around.
    await expect(promise).rejects.toThrow(/aborted/);
    expect(attempts).toBe(1);
  });
});

describe("stream idle timeout", () => {
  /** A stream that yields one chunk then goes quiet forever. */
  function stallingStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        // Never closed, never enqueued again.
      },
    });
  }

  test("throws instead of waiting forever on a stalled stream", async () => {
    const events: unknown[] = [];
    const drain = async () => {
      for await (const event of parseSse(stallingStream(), 40)) events.push(event);
    };

    await expect(drain()).rejects.toThrow(/stream stalled: no data for 40ms/);
    // The chunk that did arrive is still delivered — a stall is not a reason to lose it.
    expect(events).toHaveLength(1);
  });

  test("a slow but healthy stream is not cut off", async () => {
    // The watchdog resets per chunk, so a long generation with steady output survives a deadline
    // far shorter than its total duration. Testing that needs real time: a duration is the thing under
    // test, so there is no condition to wait on instead.
    //
    // **Known flaky under load**, roughly one full run in ten, never on its own. Forty-two test files run
    // concurrently and one scheduler stall over 60ms looks like a dead stream. Widening the margins to
    // 100ms against 300ms was tried and the failure rate got *worse* on a machine at load 10 — so the
    // numbers are back to the originals rather than carrying a change with no demonstrated benefit. See
    // recorded when it was first seen; the cause is the concurrent runner, not this assertion.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          await sleep(20);
          controller.enqueue(encoder.encode(`data: {"n":${i}}\n\n`));
        }
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSse(stream, 60)) events.push(event);
    expect(events).toHaveLength(5);
  });

  test("no watchdog when no timeout is given", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: x\n\n"));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSse(stream)) events.push(event);
    expect(events).toEqual([{ data: "x" }]);
  });
});
