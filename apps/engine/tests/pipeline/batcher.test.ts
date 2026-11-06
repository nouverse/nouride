/**
 * The media batcher's window closing onto a queue that throws (`pipeline/batcher.ts`).
 *
 * The push runs on the window's timer, and a throw out of a timer is an uncaught exception — the daemon shuts down on
 * one (`boot/shutdown.ts`), every conversation for one burst of photos. Bun fails the running test on one.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { addLogSink, type LogEntry, type MessageEnvelope } from "@nouride/shared";
import { Batcher } from "@/modules/pipeline/batcher.ts";
import { BATCH_WINDOW_MS } from "@/modules/pipeline/deps.ts";
import { envelope } from "../helpers.ts";

const errors: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "pipeline.batcher" && entry.level === "error" && errors.push(entry)));

beforeEach(() => {
  errors.length = 0;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const photo = (id: string, text: string): MessageEnvelope =>
  envelope({ id, text, attachments: [{ type: "image", mimeType: "image/jpeg", url: `file:///tmp/${id}.jpg` }] });

describe("a burst whose push throws", () => {
  test("is logged with the burst, and the next burst still reaches the queue", () => {
    const pushed: string[] = [];
    let refusals = 1;
    const batcher = new Batcher((held) => {
      if (refusals > 0) {
        refusals -= 1;
        throw new Error("the queue is draining");
      }
      pushed.push(held.text);
    });

    batcher.accept(photo("p1", "first"));
    batcher.accept(photo("p2", "and another"));
    jest.advanceTimersByTime(BATCH_WINDOW_MS);
    batcher.accept(photo("p3", "second"));
    jest.advanceTimersByTime(BATCH_WINDOW_MS);

    expect(pushed).toEqual(["second"]);
    expect(errors.map((line) => [line.message, line.data?.batch, line.data?.error])).toEqual([
      ["could not hand a held burst of media to the queue", "telegram:main:chat-1:user-1", "Error: the queue is draining"],
    ]);
  });

  test("an edit is never folded into a burst: what was held goes first, then the edit, on its own (G11)", () => {
    const pushed: MessageEnvelope[] = [];
    const batcher = new Batcher((held) => pushed.push(held));
    batcher.accept(photo("p1", "look"));
    // Found while held, for an edit of it.
    expect(batcher.find((held) => held.id === "p1")?.text).toBe("look");
    batcher.accept(envelope({ id: "m0:edited:1", text: "an edit of an earlier message", edit: { of: "m0" } }));
    expect(pushed.map((held) => [held.id, held.text])).toEqual([
      ["p1", "look"],
      ["m0:edited:1", "an edit of an earlier message"],
    ]);
    expect(pushed[1]?.edit?.of).toBe("m0");
    // Nothing is left held to be pushed again.
    jest.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(pushed).toHaveLength(2);
    expect(batcher.find(() => true)).toBeUndefined();
  });

  test("a burst still held is not pushed twice, and one merged is pushed once", () => {
    const pushed: MessageEnvelope[] = [];
    const batcher = new Batcher((held) => pushed.push(held));
    batcher.accept(photo("p1", "one"));
    jest.advanceTimersByTime(BATCH_WINDOW_MS - 1);
    batcher.accept(photo("p2", "two"));
    jest.advanceTimersByTime(BATCH_WINDOW_MS);
    jest.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.attachments).toHaveLength(2);
  });
});
