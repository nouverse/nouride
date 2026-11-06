/**
 * A line per model request (0.7.26): what each request of a turn carried, in the turn's record — its size, the tool
 * results cleared out of it and where they were kept, whether a summary was in it. On 2026-10-20/21 every one of these
 * had to be inferred from a conversation of 453 messages.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import { requestLines } from "@/modules/llm/executor/context-line.ts";
import { trimToolResults, TRIMMED_TOOL_PREFIX } from "@/modules/llm/context.ts";
import { SUMMARY_PREFIX } from "@/modules/llm/summarize.ts";

const result = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content, timestamp: 1 });
const asked = (text: string): ChatMessage => ({ role: "user", content: text, timestamp: 1 });

/**
 * Tool results cleared the way the executor clears them, each kept in a file the marker names — read by the model, which
 * has answered since: results it has not read yet are never cleared.
 */
function clearedFrom(messages: ChatMessage[]): ChatMessage[] {
  let n = 0;
  return trimToolResults([...messages, { role: "assistant", content: "next", timestamp: 2 }], {
    maxTokens: 50,
    keepRecent: 0,
    keep: () => ({ path: `/data/spill/s1/cleared-call_${++n}-ab12.txt`, lines: 120, kb: 9 }),
  }).messages;
}

describe("a request's line", () => {
  test("names the results cleared out of it and the file each was kept at — each once in a turn, not at every request", () => {
    const lines = requestLines();
    const first = clearedFrom([asked("check the 52 documents"), result("call_a", "x".repeat(3_000)), result("call_b", "y".repeat(3_000))]);
    expect(lines(first, 48_200.4)).toEqual({
      request: 1,
      estimatedTokens: 48_200,
      cleared: 2,
      keptAt: ["/data/spill/s1/cleared-call_1-ab12.txt", "/data/spill/s1/cleared-call_2-ab12.txt"],
      summary: false,
      notes: false,
    });
    // The next request still carries both, counted; their paths were said on the line before.
    expect(lines(first, 49_000)).toEqual({ request: 2, estimatedTokens: 49_000, cleared: 2, summary: false, notes: false });
  });

  test("a result dropped where nothing could keep it is counted, with no path to name", () => {
    const line = requestLines()([asked("hi"), result("call_a", `${TRIMMED_TOOL_PREFIX} — 120 lines, ~9KB.`)], 10);
    expect(line).toEqual({ request: 1, estimatedTokens: 10, cleared: 1, summary: false, notes: false });
  });

  test("says when a compaction's summary stood in for earlier turns", () => {
    const line = requestLines()([asked(`${SUMMARY_PREFIX}\nHeadline: verifying KK 1.1`), asked("next one")], 10);
    expect(line.summary).toBe(true);
  });

  test("names at most twenty paths, and counts every one", () => {
    const many = clearedFrom([asked("go"), ...Array.from({ length: 30 }, (_, i) => result(`call_${i}`, "z".repeat(3_000)))]);
    const line = requestLines()(many, 10);
    expect(line.cleared).toBe(30);
    expect(line.keptAt).toHaveLength(20);
  });

  test("says whether the work notes rode at the request's end", () => {
    const lines = requestLines();
    expect(lines([asked("hi")], 10).notes).toBe(false);
    expect(lines([asked("hi")], 10, true).notes).toBe(true);
  });
});
