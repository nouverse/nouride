/**
 * The equivalence between the two forms of `ChatParams.system`.
 *
 * These are not shape tests. Every provider relies on "blocks joined = the string form" being exact:
 * the OpenAI client joins the blocks and sends the result, the token estimator measures that string
 * to decide what fits, and an implicit prefix cache keys on its leading bytes. A separator that
 * drifted by one character would be invisible in every one of those and wrong in all of them.
 */

import { describe, expect, test } from "bun:test";
import { flattenSystem, systemBlocks } from "../src/system.ts";

describe("flattenSystem", () => {
  test("a string is itself", () => {
    expect(flattenSystem("you are a bot")).toBe("you are a bot");
  });

  test("nothing is the empty string, not the word undefined", () => {
    expect(flattenSystem(undefined)).toBe("");
    expect(flattenSystem([])).toBe("");
  });

  test("blocks join with a blank line, cache hints ignored", () => {
    expect(
      flattenSystem([{ text: "one", cache: true }, { text: "two", cache: true }, { text: "three" }]),
    ).toBe("one\n\ntwo\n\nthree");
  });

  test("an empty block does not leave a double separator behind", () => {
    // Dropping the text but keeping its separator would add two characters to the prefix — enough to
    // miss a cache that the equivalent single string would have hit.
    expect(flattenSystem([{ text: "one" }, { text: "" }, { text: "two" }])).toBe("one\n\ntwo");
  });
});

describe("systemBlocks", () => {
  test("a string becomes one uncached block", () => {
    expect(systemBlocks("you are a bot")).toEqual([{ text: "you are a bot" }]);
  });

  test("nothing becomes no blocks", () => {
    expect(systemBlocks(undefined)).toEqual([]);
    expect(systemBlocks("")).toEqual([]);
  });

  test("empty blocks are dropped — the API rejects them outright", () => {
    expect(systemBlocks([{ text: "kept", cache: true }, { text: "" }])).toEqual([
      { text: "kept", cache: true },
    ]);
  });
});
