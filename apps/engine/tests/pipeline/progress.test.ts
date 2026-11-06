import { describe, expect, test } from "bun:test";
import { createGenerationProgress } from "@/modules/llm/progress.ts";

/** A clock the test drives, so no assertion here depends on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("reporting progress during a long generation", () => {
  test("says nothing until an interval has passed", () => {
    // The first fragment starts the clock rather than emitting. A "generating · 0B" line during the wait
    // before any token arrives would be describing nothing happening.
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 3000, now: c.now });

    p.add("hello");
    expect(lines).toEqual([]);

    c.advance(2999);
    p.add(" world");
    expect(lines).toEqual([]);

    c.advance(2);
    p.add("!");
    expect(lines).toEqual(["generating · 12B"]);
  });

  test("one line per interval, however many fragments arrive", () => {
    // Unthrottled this would be one event per fragment, and the activity ring holds sixty — the tool calls
    // someone wants to see would be evicted to show the same line hundreds of times.
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 3000, now: c.now });

    p.add("x");
    for (let i = 0; i < 500; i++) p.add("y");
    expect(lines).toEqual([]);

    c.advance(3000);
    p.add("z");
    expect(lines).toHaveLength(1);
  });

  test("counts bytes, not characters", () => {
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 1000, now: c.now });

    p.add("a");
    c.advance(1000);
    // Three characters, nine bytes. Reporting length would understate every non-ASCII file.
    p.add("→→→");
    expect(p.bytes()).toBe(10);
    expect(lines).toEqual(["generating · 10B"]);
  });

  test("an empty fragment is not a fragment", () => {
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 1000, now: c.now });

    p.add("");
    c.advance(5000);
    p.add("");
    expect(lines).toEqual([]);
    expect(p.bytes()).toBe(0);
  });

  test("an absolute total from the client replaces rather than adds", () => {
    // The provider clients count tool-argument bytes themselves and report a running total, so a re-sent
    // chunk cannot inflate the figure.
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 1000, now: c.now });

    p.setBytes(1024);
    c.advance(1000);
    p.setBytes(2048);

    expect(p.bytes()).toBe(2048);
    expect(lines).toEqual(["generating · 2KB"]);
  });

  test("a total that goes backwards is ignored", () => {
    // A smaller number means the count restarted. Showing a size shrinking mid-generation would read as
    // corruption; holding the last figure is the honest option.
    const c = clock();
    const p = createGenerationProgress(() => {}, { intervalMs: 1000, now: c.now });

    p.setBytes(5000);
    p.setBytes(10);
    expect(p.bytes()).toBe(5000);
  });

  test("scales to a real file without pretending to precision", () => {
    const lines: string[] = [];
    const c = clock();
    const p = createGenerationProgress((l) => lines.push(l), { intervalMs: 1000, now: c.now });

    p.setBytes(1);
    c.advance(1000);
    p.setBytes(5_388); // the size that took eighty silent seconds
    expect(lines).toEqual(["generating · 5KB"]);
  });
});
