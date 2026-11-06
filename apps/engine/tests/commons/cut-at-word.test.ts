import { describe, expect, test } from "bun:test";
import { cutAtWord } from "@/commons/cut-at-word.ts";

describe("cutAtWord", () => {
  test("text that fits comes back as it is", () => {
    expect(cutAtWord("fits", 10)).toBe("fits");
    expect(cutAtWord("exactly ten", 11)).toBe("exactly ten");
  });

  test("a cut ends at a word, with the ellipsis inside the limit", () => {
    const cut = cutAtWord("one two three four five six", 16);
    expect(cut).toBe("one two three…");
    expect(cut.length).toBeLessThanOrEqual(16);
  });

  test("punctuation left at the end of the cut goes, so it never reads ',…'", () => {
    expect(cutAtWord("first, second third fourth", 15)).toBe("first, second…");
    expect(cutAtWord("alpha beta, gamma delta", 13)).toBe("alpha beta…");
  });

  test("one long word is cut where the room ends rather than to almost nothing", () => {
    const path = `see ${"x".repeat(60)}`;
    expect(cutAtWord(path, 20)).toBe(`see ${"x".repeat(15)}…`);
    expect(cutAtWord(path, 20)).toHaveLength(20);
  });

  test("the floor is the caller's: a space before it is not used", () => {
    expect(cutAtWord("ab cdefghijklmnop", 10, 3)).toBe("ab cdefgh…");
    expect(cutAtWord("ab cdefghijklmnop", 10, 2)).toBe("ab…");
  });
});
