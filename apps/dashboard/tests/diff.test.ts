/**
 * Every diff the dashboard draws, read one way (0.8.8, `commons/lib/diff.ts`): the line diff, its counts, and the pieces
 * `DiffView` draws — an unchanged run away from a change folded, a short one drawn.
 */

import { describe, expect, test } from "bun:test";
import { diffCounts, diffLines, diffPieces, type DiffRow } from "@/commons/lib/diff";

const same = (text: string): DiffRow => ({ sign: " ", text });

describe("the line diff", () => {
  test("what stayed, what went and what came, in order — counted", () => {
    const rows = diffLines(["a", "b", "c"], ["a", "B", "c", "d"]);
    expect(rows).toEqual([same("a"), { sign: "-", text: "b" }, { sign: "+", text: "B" }, same("c"), { sign: "+", text: "d" }]);
    expect(diffCounts(rows)).toEqual({ added: 2, removed: 1 });
  });
});

describe("the pieces drawn", () => {
  test("a long unchanged run away from a change is folded; three lines of context stay on each side", () => {
    // One added pitfall in a sixty-line skill: the reviewer should not hunt for it among the fifty-nine that stayed.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const after = [...before.slice(0, 20), "a new pitfall", ...before.slice(20)];
    const pieces = diffPieces(diffLines(before, after));
    expect(pieces.map((piece) => [piece.kind, piece.rows.length])).toEqual([
      ["folded", 17],
      ["rows", 7],
      ["folded", 7],
    ]);
    expect(pieces[1]!.rows[3]).toEqual({ sign: "+", text: "a new pitfall" });
  });

  test("a fold of fewer than three lines is drawn, joined to the lines beside it; nothing changed is one fold", () => {
    const rows = [same("a"), same("b"), { sign: "+" as const, text: "x" }, same("c"), same("d"), same("e"), same("f"), same("g"), { sign: "-" as const, text: "y" }];
    // `context` 2: c, d after x and f, g before y; e alone between them is drawn, not folded.
    expect(diffPieces(rows, 2).map((piece) => [piece.kind, piece.rows.length])).toEqual([["rows", 9]]);
    expect(diffPieces([same("a"), same("b")]).map((piece) => piece.kind)).toEqual(["folded"]);
    expect(diffPieces([])).toEqual([]);
  });
});
