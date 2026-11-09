/**
 * The text helpers, each holding the result every copy it replaced gave its caller: where a budget ends, which side
 * of it the "…" falls, what a cut keeps.
 */

import { describe, expect, test } from "bun:test";
import { clip, clipTrimmed, cutAtWord, elide, joinLines, keepEnds, oneLine, plural } from "../src/text.ts";

describe("oneLine", () => {
  test("every run of whitespace, line breaks and tabs included, is one space, and the ends are trimmed", () => {
    expect(oneLine("  first\n\n  second\tthird  ")).toBe("first second third");
    expect(oneLine("a  b")).toBe("a b");
  });

  test("an empty or blank text is empty", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine(" \n\t ")).toBe("");
  });
});

describe("joinLines", () => {
  test("line breaks inside a step become spaces, and the ends are trimmed", () => {
    expect(joinLines("The user wants me to:\n1.\n Use delegate\n2. ")).toBe("The user wants me to: 1. Use delegate 2.");
    expect(joinLines("one line")).toBe("one line");
  });

  test("the spaces inside a line are kept, unlike oneLine's", () => {
    expect(joinLines("a  b\n\n  c")).toBe("a  b c");
    expect(oneLine("a  b\n\n  c")).toBe("a b c");
  });
});

describe("clip", () => {
  test("a text that fits comes back as it is, at the budget too", () => {
    expect(clip("fits", 10)).toBe("fits");
    expect(clip("x".repeat(10), 10)).toBe("x".repeat(10));
  });

  test("a cut keeps max - 1 characters, so the result with its '…' is exactly max", () => {
    const cut = clip("x".repeat(11), 10);
    expect(cut).toBe(`${"x".repeat(9)}…`);
    expect(cut).toHaveLength(10);
  });

  test("keep = max puts the '…' after the budget: max + 1 in all", () => {
    expect(clip("x".repeat(11), 10, 10)).toBe(`${"x".repeat(10)}…`);
    expect(clip("x".repeat(10), 10, 10)).toBe("x".repeat(10));
  });

  test("keep is how much a cut keeps, whatever the budget it is over", () => {
    expect(clip("x".repeat(80), 80, 77)).toBe("x".repeat(80));
    expect(clip("x".repeat(81), 80, 77)).toBe(`${"x".repeat(77)}…`);
  });

  test("a space the cut ends on is kept", () => {
    expect(clip("two words and more", 11)).toBe("two words …");
  });
});

describe("clipTrimmed", () => {
  test("the space a cut ends on goes before the '…'", () => {
    expect(clipTrimmed("two words and more", 11)).toBe("two words…");
    expect(clipTrimmed("two words and more", 13, 10)).toBe("two words…");
  });

  test("a text that fits, and a cut on a letter, read as clip's", () => {
    expect(clipTrimmed("fits", 10)).toBe("fits");
    expect(clipTrimmed("abcdefghijkl", 10)).toBe(clip("abcdefghijkl", 10));
  });
});

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

describe("elide", () => {
  test("a line inside its budget is untouched", () => {
    expect(elide("exec kubectl get pods -A", 140)).toBe("exec kubectl get pods -A");
  });

  test("a cut line never exceeds the budget it was given", () => {
    for (const max of [10, 40, 120, 140]) {
      expect(elide("y".repeat(500), max).length).toBeLessThanOrEqual(max);
    }
  });

  test("both ends survive, a third of the room for the end", () => {
    expect(elide(`START${"-".repeat(200)}END`, 40)).toStartWith("START");
    expect(elide(`START${"-".repeat(200)}END`, 40)).toEndWith("END");
    expect(elide("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdef…xyz");
  });
});

describe("keepEnds", () => {
  test("a text that fits comes back as it is", () => {
    expect(keepEnds("short", 10)).toBe("short");
  });

  test("half the budget from each end, and how much was left out between them, on a line of its own", () => {
    expect(keepEnds(`${"a".repeat(10)}${"b".repeat(10)}`, 10)).toBe("aaaaa\n[… 10 characters left out …]\nbbbbb");
  });

  test("an odd budget keeps the half rounded down at each end", () => {
    expect(keepEnds("abcdefghij", 7)).toBe("abc\n[… 3 characters left out …]\nhij");
  });

  test("the line's words are the caller's when it says them", () => {
    expect(keepEnds("abcdefghij", 4, (left) => `…[${left} characters cut]…`)).toBe("ab\n…[6 characters cut]…\nij");
  });
});

describe("plural", () => {
  test("one of something takes the word as it is; any other count, an 's'", () => {
    expect(`1 ${plural(1, "file")}`).toBe("1 file");
    expect(`0 ${plural(0, "file")}`).toBe("0 files");
    expect(`3 ${plural(3, "file")}`).toBe("3 files");
  });

  test("a word whose plural is not an 's' names it", () => {
    expect(plural(2, "copy", "copies")).toBe("copies");
    expect(plural(1, "copy", "copies")).toBe("copy");
  });
});
