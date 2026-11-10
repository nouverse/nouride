import { describe, expect, test } from "bun:test";
import { createReasoningStream } from "@/modules/llm/reasoning.ts";
import { formatActivityLine, formatElapsed } from "../../../cli/src/activity-view.ts";

/** Collect what a stream emits, driving it with fragments the way a provider does. */
function collect(fragments: string[], flush = true): string[] {
  const lines: string[] = [];
  const stream = createReasoningStream((line) => lines.push(line));
  for (const fragment of fragments) stream.push(fragment);
  if (flush) stream.flush();
  return lines;
}

describe("turning streamed reasoning into readable lines", () => {
  test("a thought split across fragments comes out as one line", () => {
    // How it actually arrives: a few characters at a time, mid-word.
    const lines = collect(["I need to calc", "ulate 17 ", "× 23."]);

    expect(lines).toEqual(["I need to calculate 17 × 23."]);
  });

  test("emits per sentence rather than per fragment", () => {
    // One event per fragment would be hundreds per turn through a sixty-event ring buffer — the start of
    // a thought would be evicted before its end arrived.
    const lines = collect(["First step. ", "Second step. ", "Third"]);

    expect(lines).toEqual(["First step.", "Second step.", "Third"]);
  });

  test("questions and exclamations end a line too", () => {
    expect(collect(["What is 17×23? Let me work it out."])).toEqual([
      "What is 17×23?",
      "Let me work it out.",
    ]);
  });

  test("a decimal point does not end a sentence", () => {
    // `search(/[.!?](\s|$)/)` requires whitespace or end after the mark, so `3.14` stays whole.
    expect(collect(["pi is 3.14 roughly."])).toEqual(["pi is 3.14 roughly."]);
  });

  test("newlines break lines even without punctuation", () => {
    expect(collect(["step one\nstep two\n"])).toEqual(["step one", "step two"]);
  });

  test("a very long run without punctuation is broken at a word boundary", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const lines = collect([words]);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
    // Broken between words, not through one.
    expect(lines.every((l) => !l.startsWith("ord") && !l.endsWith("wor"))).toBe(true);
  });

  test("nothing is emitted for whitespace alone", () => {
    expect(collect(["   ", "\n", "  \n "])).toEqual([]);
  });

  test("an unfinished thought still appears on flush", () => {
    // A turn that ends mid-sentence — the model stopped reasoning and started answering. Dropping the
    // remainder would silently lose the last thing it was working on.
    expect(collect(["almost don"], true)).toEqual(["almost don"]);
  });

  test("without a flush, a partial thought is held rather than shown twice", () => {
    expect(collect(["complete. partial"], false)).toEqual(["complete."]);
  });

  test("a single enormous sentence is clipped, not dropped", () => {
    const huge = `${"x".repeat(400)}.`;
    const lines = collect([huge]);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });
});

describe("the elapsed timer", () => {
  test("reads naturally at every scale", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(95_000)).toBe("1m35s");
    expect(formatElapsed(600_000)).toBe("10m");
  });

  test("a sub-second step shows no number", () => {
    // `· 0s` on a step that finished instantly reads like a stall, which is the opposite of the point.
    expect(formatActivityLine("thinking", 400)).toBe("thinking");
    expect(formatActivityLine("thinking", 8_400)).toBe("thinking · 8s");
  });

  test("a line that already carries its own duration is not timed again", () => {
    // `tool_done` lines come from the daemon with the real duration in them. A second number measuring
    // the round trip to the poller would contradict it.
    expect(formatActivityLine("write ok · 12ms")).toBe("write ok · 12ms");
  });
});
