/**
 * Where a long reply is cut, part by part.
 *
 * `markdown.test.ts` holds the invariants — every part within the limit, every fence balanced — and the 0.7.11
 * mutation sweep found them satisfied by a cutter that cut in the wrong places: the re-fit loop in `nextPart`
 * corrects any budget mistake by sending more, smaller parts, so 57 mutants of `commons/text.ts` survived. These pin
 * the parts themselves. One of them was a bug: the cut was the *latest* of a paragraph break, a line break and a
 * space, so a space always won — a fenced listing was cut mid-line, and a reply mid-sentence with its paragraph break
 * in reach.
 */

import { describe, expect, test } from "bun:test";
import { chunk, chunkRendered } from "../src/commons/text.ts";

describe("where a part ends", () => {
  test("at a paragraph break before a later line break or space, when it is in the second half of the window", () => {
    expect(chunk("one two\nthree four\n\nfive six seven", 30)).toEqual(["one two\nthree four", "five six seven"]);
    expect(chunk("the first line here\nsecond line is longer", 30)).toEqual(["the first line here", "second line is longer"]);
  });

  test("a fenced listing is cut between its lines, not inside one, and each part reopens with the language", () => {
    const lines = Array.from({ length: 6 }, (_, i) => `row ${i} ${"=".repeat(12)}`).join("\n");
    expect(chunk("```ts\n" + lines + "\n```", 60)).toEqual([
      "```ts\nrow 0 ============\nrow 1 ============\n```",
      "```ts\nrow 2 ============\nrow 3 ============\n```",
      "```ts\nrow 4 ============\nrow 5 ============\n```",
    ]);
  });

  test("a tilde fence closes with tildes, and an indented one still closes", () => {
    expect(chunk("~~~\n" + "q".repeat(30) + "\n" + "r".repeat(30) + "\n~~~", 40)).toEqual([
      "~~~\n" + "q".repeat(30) + "\n~~~",
      "~~~\n" + "r".repeat(30) + "\n~~~",
    ]);
    expect(chunk("text\n  ```\n" + "s".repeat(30) + "\n" + "t".repeat(30) + "\n  ```", 40)).toEqual([
      "text\n  ```\n" + "s".repeat(25) + "\n```",
      "```\nsssss\n" + "t".repeat(26) + "\n```",
      "```\ntttt\n  ```",
    ]);
  });

  test("words when there is no line to cut at, and the budget itself when the only space is too early", () => {
    expect(chunk("alpha beta gamma delta epsilon zeta eta theta", 20)).toEqual(["alpha beta gamma", "delta epsilon zeta", "eta theta"]);
    expect(chunk(`a ${"b".repeat(100)}`, 50)).toEqual([`a ${"b".repeat(48)}`, "b".repeat(50), "bb"]);
  });

  test("text exactly at the limit is one part, and a last part of one character is still sent", () => {
    expect(chunk("abcde", 5)).toEqual(["abcde"]);
    expect(chunk("a".repeat(11), 5)).toEqual(["aaaaa", "aaaaa", "a"]);
  });
});

describe("re-cutting against the rendered length", () => {
  test("a render that doubles the text is cut once per part, as many parts as it needs and no more", () => {
    expect(chunkRendered("alpha beta gamma delta epsilon zeta eta theta iota kappa", 30, (s) => s + s)).toEqual([
      "alpha beta",
      "gamma delta",
      "epsilon zeta",
      "eta theta",
      "iota kappa",
    ]);
  });

  test("a part that never fits is re-cut six times and then sent as it is", () => {
    // Longer than two characters renders past the limit whatever its length: the budget shrinks two a try.
    const parts = chunkRendered("a".repeat(300), 100, (s) => (s.length > 2 ? "x".repeat(101) : s));
    expect(parts.map((p) => p.length)).toEqual([88, 88, 88, 24, 2, 2, 2, 2, 2, 2]);
  });
});
