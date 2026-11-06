/**
 * Fusing the keyword and the meaning rankings (M11). The exact-match bonus was three rankings' worth: a
 * keyword-only hit at second place outranked an item both rankings put near the top. In shares of a first
 * place, the two properties it is for both hold.
 */

import { describe, expect, test } from "bun:test";
import { fuse } from "@/modules/memory/semantic.ts";

/** A ranking with `item` at `rank`, the places before it filled. */
const at = (item: string, rank: number, prefix: string) => [...Array.from({ length: rank }, (_, i) => `${prefix}${i}`), item];

describe("the exact-match bonus", () => {
  test("an exact hit in the keyword top three outranks an item only meaning found, its first included", () => {
    for (const rank of [0, 1, 2]) {
      const score = fuse([at("exact", rank, "w"), at("meant", 0, "m")], { exact: at("exact", rank, "w") });
      expect(score.get("exact")!, `keyword rank ${rank}`).toBeGreaterThan(score.get("meant")!);
    }
  });

  test("an item both rankings place in their top three outranks one found by either alone, bonus and all", () => {
    // The agreed item as low as it can be and still be in both top threes; the lone hit above it.
    for (const lone of [0, 1]) {
      const words = at("agreed", 2, "w");
      words[lone] = "keyword-only";
      const meaning = at("agreed", 2, "m");
      const score = fuse([words, meaning], { exact: words });
      expect(score.get("agreed")!, `keyword-only at ${lone}`).toBeGreaterThan(score.get("keyword-only")!);
    }
  });
});
