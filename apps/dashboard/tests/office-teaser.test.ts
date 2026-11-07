/**
 * The Office on the Overview (0.8.15): where the Agents and Gateways lists were, a line of who is doing what.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { officeCounts } from "@/modules/home/OfficeTeaser";

describe("the Overview's office line", () => {
  test("each status someone is in, in the legend's order, and nothing for one nobody is in", () => {
    expect(officeCounts(["idle", "working", "asleep", "working", "waiting"])).toBe("2 working · 1 waiting for you · 1 idle · 1 asleep");
    expect(officeCounts(["asleep"])).toBe("1 asleep");
    expect(officeCounts([])).toBe("");
  });
});

describe("the Overview's office picture", () => {
  // On a phone the office was drawn at a 1 000 px guess, over the cards below it (the owner, 2026-11-07): the box it
  // measures appears only once the agents have loaded, after the one look a mount-time ref got.
  test("is sized from its box whenever the box appears, and never from a guess", () => {
    const source = readFileSync(join(import.meta.dir, "../src/modules/home/OfficeTeaser.tsx"), "utf8");
    expect(source).toContain("ref={setBox}");
    expect(source).toContain("}, [box]);");
    expect(source).toContain("useState(0)");
    expect(source).not.toContain("1_000");
  });
});
