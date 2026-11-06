/**
 * The range the tool budget controls advise is the daemon's, not a number this page remembers.
 *
 * The default went to 250 and this copy stayed at 25 to 100, so both controls (`ToolBudgetControl`, `AgentToolBudget`)
 * met a fresh install's own setting with "Above 100, prefer a background job". The dashboard cannot import
 * `TOOL_ITERATIONS_ADVISED`, so it is read here from its source, the way the page's other copies are held to theirs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWEET_SPOT } from "@/modules/agents/components/ToolBudgetControl";

const CONFIG = join(import.meta.dir, "..", "..", "..", "packages", "shared", "src", "types", "config.ts");

describe("the tool budget's advised range", () => {
  test("is the one the daemon advises, so the shipped default draws no warning", () => {
    const match = readFileSync(CONFIG, "utf8").match(/TOOL_ITERATIONS_ADVISED = \{ from: (\d+), to: (\d+) \}/);
    expect(match).not.toBeNull();
    expect(SWEET_SPOT).toEqual({ from: Number(match![1]), to: Number(match![2]) });
  });
});
