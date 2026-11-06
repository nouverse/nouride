import { describe, expect, test } from "bun:test";
import { eventJson, parseSse } from "../src/sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const event of parseSse(stream)) out.push(event);
  return out;
}

describe("parseSse", () => {
  test("parses events separated by a blank line", async () => {
    const events = await collect(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n'));
    expect(events).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }]);
  });

  test("keeps the event name when present", async () => {
    const events = await collect(streamOf('event: message_start\ndata: {"type":"x"}\n\n'));
    expect(events[0]).toEqual({ event: "message_start", data: '{"type":"x"}' });
  });

  test("reassembles an event split across chunk boundaries", async () => {
    // The failure this guards against: a chunk boundary inside a JSON field. Splitting
    // per chunk would emit two corrupt events instead of one valid one.
    const events = await collect(streamOf('data: {"content":"hel', 'lo world"}\n', "\n"));
    expect(events).toEqual([{ data: '{"content":"hello world"}' }]);
  });

  test("handles CRLF line endings", async () => {
    const events = await collect(streamOf('data: {"a":1}\r\n\r\n'));
    expect(events).toEqual([{ data: '{"a":1}' }]);
  });

  test("concatenates multiple data lines in one event", async () => {
    const events = await collect(streamOf("data: line1\ndata: line2\n\n"));
    expect(events[0]?.data).toBe("line1\nline2");
  });

  test("skips comment/keep-alive lines", async () => {
    const events = await collect(streamOf(": ping\n\ndata: real\n\n"));
    expect(events).toEqual([{ data: "real" }]);
  });

  test("emits a trailing event with no terminating blank line", async () => {
    const events = await collect(streamOf("data: last\n"));
    expect(events).toEqual([{ data: "last" }]);
  });
});

describe("eventJson", () => {
  test("parses JSON payloads", () => {
    expect(eventJson<{ a: number }>({ data: '{"a":1}' })).toEqual({ a: 1 });
  });

  test("returns null for the [DONE] terminator", () => {
    expect(eventJson({ data: "[DONE]" })).toBeNull();
  });

  test("returns null rather than throwing on malformed JSON", () => {
    expect(eventJson({ data: "{not json" })).toBeNull();
  });
});
