/**
 * "Did you mean" after a typo (0.8.23): the one known word closest to what was typed, or none. A wrong word was answered
 * with "Run `nouride help`" alone, and an agent's `nouride` tool spent a turn reading the help to find the one letter.
 */

import { describe, expect, test } from "bun:test";
import { nearest } from "@/cli/nearest.ts";
import { meantCommand } from "@/cli/grammar.ts";

describe("the word most likely meant", () => {
  test("one letter added, missing, changed, or two swapped", () => {
    expect(nearest("missions", ["mission", "memory", "mcp"])).toBe("mission");
    expect(nearest("knowlege", ["knowledge", "jobs"])).toBe("knowledge");
    expect(nearest("lsit", ["list", "set", "rm"])).toBe("list");
    expect(nearest("agnet", ["agent", "agents"])).toBe("agent");
  });

  test("nothing close enough: a word of up to six letters one edit away at most, a longer one two", () => {
    expect(nearest("zzzz", ["list", "show"])).toBeNull();
    expect(nearest("lgx", ["log"])).toBeNull();
    // Two edits from `logs`, which a five-letter word is not allowed.
    expect(nearest("bogus", ["logs"])).toBeNull();
    expect(nearest("knwldg", ["knowledge"])).toBeNull();
    expect(nearest("knwldge", ["knowledge"])).toBe("knowledge");
  });

  test("two as close as each other: no guess, which would be wrong as often as right; two names of one thing are one", () => {
    expect(nearest("lst", ["ls", "list"])).toBeNull();
    expect(nearest("lst", ["ls", "list"], () => "list")).toBe("list");
  });

  test("the word itself is no typo; case is not a difference", () => {
    expect(nearest("list", ["list", "lst"])).toBeNull();
    expect(nearest("MISSIONS", ["mission"])).toBe("mission");
  });

  test("a command, by the name it is dispatched under, an alias given as its command", () => {
    expect(meantCommand("missions")).toBe("mission");
    expect(meantCommand("knowlege")).toBe("knowledge");
    expect(meantCommand("secrest")).toBe("secret");
    expect(meantCommand("frobnicate")).toBeNull();
  });
});
