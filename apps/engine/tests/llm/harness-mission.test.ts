/**
 * What the harness tells an agent about missions. A prompt is behaviour, so the words that carry the rule are
 * asserted. Since 0.8.17 a mission is long work, more than about an hour, that goes on with
 * little from the person: the hour a reply and a helper in the background have. Before, "many steps or items" drafted
 * missions for work of ten minutes. It is said in "Who does the work" beside the other ways (`harness-work.test.ts`),
 * and started as a draft the person starts.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import { WHEN_TO_START } from "@/modules/tools/builtins/mission.ts";

function harness(toolNames: string[], startsMissions: boolean): string {
  return renderTools({
    ctx: { harness: { maxToolIterations: 8, approvalAvailable: true, ...(startsMissions ? { startsMissions: true } : {}) } },
    toolNames,
    gated: [],
    free: toolNames,
  } as never).join("\n");
}

describe("the harness on missions", () => {
  test("a mission is long work, more than about an hour, with little from the person, and what it gives", () => {
    const text = harness(["mission"], true);
    expect(text).toContain("Long work, more than about an hour, that goes on with little from the person goes to a mission: long development, a deep analysis, a long scan or sweep, research across many sources, a migration, anything that waits on CI or a long command, or work that should go on while the person is away.");
    expect(text).toContain("A mission keeps this chat free, survives restarts, keeps going on its own (it works around what fails and proves itself done with checks) and is signed off.");
    // "many steps" drafted missions for ten minutes of work; it is not a reason any more.
    expect(text).not.toContain("many steps");
    expect(text).not.toContain("ten minutes");
  });

  test("started as a draft the person starts, and signed off by who is there", () => {
    const text = harness(["mission"], true);
    expect(text).toContain('With `mission`: action "start" drafts it (a goal, a brief and checks that prove it done); "edit" changes the draft until the person starts it.');
    expect(text).toContain("From a chat, `mission` makes a draft the person starts; say what it will do and how it will be judged done. Start it at once only when the person asked for that, with their words in `said`.");
    expect(text).toContain("Who signs it off: the person in this chat following the work gets checks, then `accept`, with `no_review`; the person away or leaving (\"do it, I'm off to sleep\") gets checks and the reviewer.");
  });

  test("where it is read alone (the tool's description, a coding CLI's instructions), shorter work is sent elsewhere", () => {
    expect(WHEN_TO_START).toContain("Shorter work is not a mission's: a few minutes is done here; longer, it goes to a helper or another agent in the background.");
    expect(WHEN_TO_START.startsWith("Long work, more than about an hour,")).toBe(true);
  });

  test("not said where this turn cannot start one: a mission's own, a schedule's", () => {
    expect(harness(["mission"], false)).not.toContain("more than about an hour");
    expect(harness(["mission"], false)).not.toContain("With `mission`");
  });
});
