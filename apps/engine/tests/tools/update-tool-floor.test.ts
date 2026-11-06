/**
 * What the agent's `update` tool tells the model when the newest release needs a newer version first: the stepping
 * stone and why — never "up to date" while a newer release exists.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { createUpdateTool } from "@/modules/tools/builtins/update.ts";
import type { UpdateCheck } from "@/modules/update/index.ts";

const FLOOR = { release: "v0.8.0", needs: "0.7.14", message: "update to 0.7.14 first; 0.8.0 needs it" };

async function told(check: UpdateCheck): Promise<string> {
  const tool = createUpdateTool({
    check: async () => check,
    apply: async () => {
      throw new Error("not called");
    },
  });
  return (await tool.execute({ action: "check" }, {} as ToolContext)).content;
}

describe("the update tool, below a release's floor", () => {
  test("names the stepping stone and why", async () => {
    const said = await told({ current: "0.7.11", latest: "v0.7.14", newer: true, track: "latest", publishedAt: null, notesUrl: null, floor: FLOOR });
    expect(said).toContain("0.7.11 → v0.7.14");
    expect(said).toContain("update to 0.7.14 first; 0.8.0 needs it");
  });

  test("with no stone, says so instead of 'up to date'", async () => {
    const said = await told({ current: "0.7.11", latest: "0.7.11", newer: false, track: "latest", publishedAt: null, notesUrl: null, floor: FLOOR });
    expect(said).toContain("update to 0.7.14 first");
    expect(said).not.toContain("Up to date");
  });
});
