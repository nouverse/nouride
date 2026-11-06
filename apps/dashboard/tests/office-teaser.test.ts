/**
 * The Office on the Overview (0.8.15): where the Agents and Gateways lists were, a line of who is doing what.
 */

import { describe, expect, test } from "bun:test";
import { officeCounts } from "@/modules/home/OfficeTeaser";

describe("the Overview's office line", () => {
  test("each status someone is in, in the legend's order, and nothing for one nobody is in", () => {
    expect(officeCounts(["idle", "working", "asleep", "working", "waiting"])).toBe("2 working · 1 waiting for you · 1 idle · 1 asleep");
    expect(officeCounts(["asleep"])).toBe("1 asleep");
    expect(officeCounts([])).toBe("");
  });
});
