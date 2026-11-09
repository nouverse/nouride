/**
 * An agent at work, in a conversation: its steps fold to one line (`LiveStepLine`) with the newest of them, how many and
 * for how long; a press opens the list under it, another folds it. The fixture's conversation has a turn at work. Opened,
 * here and under a finished answer, the newest steps are whole rows and the earlier ones a press away.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
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

  const calls = Array.from({ length: 9 }, (_, i) => [
    { seq: 10 + i * 2, at: 0, kind: "tool", text: `read file-${i}.ts`, callId: `r${i}`, name: "read", ms: 0 },
    { seq: 11 + i * 2, at: 0, kind: "tool_done", text: "read ok", callId: `r${i}`, name: "read", ms: 40 },
  ]).flat();
  const files = (root: Element) => (root.textContent ?? "").match(/file-\d/g) ?? [];

  // Opened, the list was a box scrolled to its newest row: at its top, under the reasoning's heading, a sliver of a row
  // cut off, at every width. Now the newest rows are whole, and the earlier ones a press away.
  test("opened, it shows the newest rows whole and the earlier ones on a press, in no box that scrolls", async () => {
    const live = WIRE["/sessions/ses_1/live"] as { turn: { steps: Record<string, unknown>[] } } & Record<string, unknown>;
    answer({ "/sessions/ses_1/live": { status: 200, body: { ...live, turn: { ...live.turn, steps: [live.turn.steps[0], ...calls], cursor: 27 } } } });
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_1", async (host) => {
      const line = () => host.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
      const list = () => host.ownerDocument.getElementById(line()!.getAttribute("aria-controls")!)!;
      const earlier = () => [...list().querySelectorAll("button")].find((button) => button.textContent?.includes("earlier"));
      await eventually(() => line()?.textContent?.includes("9 steps") === true, 3_000, "the step line");
      line()!.click();
      await eventually(() => files(list()).length > 0, 2_000, "opened");
      seen.shown = files(list());
      seen.earlier = earlier()?.textContent;
      seen.scrolls = [...list().querySelectorAll("div")].some((box) => box.className.includes("overflow-y-auto"));
      earlier()!.click();
      await eventually(() => files(list()).length === 9, 2_000, "every row");
      seen.all = files(list());
      seen.after = earlier() === undefined;
    });
    expect(seen.shown).toEqual(["file-3", "file-4", "file-5", "file-6", "file-7", "file-8"]);
    expect(seen.earlier).toBe("Show 3 earlier steps");
    expect(seen.scrolls).toBe(false);
    expect(seen.all).toEqual(["file-0", "file-1", "file-2", "file-3", "file-4", "file-5", "file-6", "file-7", "file-8"]);
    expect(seen.after).toBe(true);
  });

  test("a finished answer's steps, opened, are whole rows too", async () => {
    const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
    const done = { ...transcript.turns[0], toolCalls: 9, steps: calls };
    answer({
      "/sessions/ses_1/turns": { status: 200, body: { ...transcript, turns: [done] } },
      "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } },
      "/turns/turn_1": { status: 404, body: { error: "no record" } },
    });
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_1", async (host) => {
      const pill = () => [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("9 steps"));
      await eventually(() => pill() !== undefined, 3_000, "the finished steps");
      pill()!.click();
      await eventually(() => files(host).length > 0, 2_000, "opened");
      seen.shown = files(host);
      seen.earlier = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("earlier"))?.textContent;
      seen.scrolls = [...host.querySelectorAll("div")].some((box) => box.className.includes("max-h-72"));
    });
    expect(seen.shown).toEqual(["file-3", "file-4", "file-5", "file-6", "file-7", "file-8"]);
    expect(seen.earlier).toBe("Show 3 earlier steps");
    expect(seen.scrolls).toBe(false);
  });
});
