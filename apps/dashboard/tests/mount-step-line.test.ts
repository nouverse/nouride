/**
 * An agent at work, in a conversation: its steps fold to one line (`LiveStepLine`) with the newest of them, how many and
 * for how long; a press opens the whole list under it, another folds it. The fixture's conversation has a turn at work.
 */

import { describe, expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("an agent at work", () => {
  test("its steps fold to one line, the newest, the count and the time; a press opens them, another folds them", async () => {
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_1", async (host) => {
      const line = () => host.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
      const list = () => host.ownerDocument.getElementById(line()!.getAttribute("aria-controls")!);
      await eventually(() => line() !== null, 3_000, "the step line");
      seen.folded = line()!.getAttribute("aria-expanded");
      seen.line = line()!.textContent;
      seen.listHidden = list()?.hasAttribute("hidden");
      line()!.click();
      await eventually(() => line()!.getAttribute("aria-expanded") === "true", 2_000, "opened");
      seen.open = list()?.textContent;
      line()!.click();
      await eventually(() => line()!.getAttribute("aria-expanded") === "false", 2_000, "folded again");
      seen.refolded = list()?.hasAttribute("hidden");
    });
    expect(seen.folded).toBe("false");
    expect(seen.listHidden).toBe(true);
    // The fixture's turn waits on an approval for its exec, its newest step.
    expect(seen.line).toContain("waiting for approval: exec");
    expect(seen.line).toMatch(/· 3 steps · /);
    expect(seen.open).toContain("delegate 1 task");
    expect(seen.refolded).toBe(true);
  });
});
