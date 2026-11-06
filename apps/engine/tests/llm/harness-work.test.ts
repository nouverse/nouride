/**
 * "Who does the work" (0.8.17): one block for doing it here, a helper (`delegate`), another agent (`ask_agent`) and a
 * mission, decided by whose work it is and how long it will take. The three lines it replaced, one beside each tool,
 * overlapped, and work of ten minutes was drafted as a mission (the owner, 2026-11-04). The bar between the background
 * and a mission is the hour a reply has. Each line is said only where the agent holds what it names.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";

function harness(toolNames: string[], opts: { missions?: boolean; background?: number } = {}): string {
  return renderTools({
    ctx: {
      harness: {
        maxToolIterations: 8,
        approvalAvailable: true,
        ...(opts.missions ? { startsMissions: true } : {}),
        ...(opts.background === undefined ? {} : { backgroundHelpers: opts.background }),
      },
    },
    toolNames,
    gated: [],
    free: toolNames,
  } as never).join("\n");
}

const all = () => harness(["delegate", "ask_agent", "mission"], { missions: true, background: 2 });

describe("who does the work", () => {
  test("two questions, decided before the first call", () => {
    expect(all()).toContain("- **Who does the work** is two questions: whose work is it, and how long will it take? Decide before your first call, not halfway through.");
  });

  test("a few minutes and yours: here; independent questions to helpers at once, waited for", () => {
    expect(all()).toContain("  - A few minutes, and yours: do it here. Several independent questions you need before you can answer (four hosts to check, three logs to read): `delegate` them in one call; up to four run at once and you wait.");
  });

  test("another agent's work: ask_agent, and the answer reported", () => {
    expect(all()).toContain("  - Another agent's (their skills, tools or access; OTHER AGENTS says what each is for): `ask_agent`, and you report their answer.");
  });

  test("under an hour: the background, a helper for yours and the other agent for theirs; past it, a mission", () => {
    expect(all()).toContain("  - Longer, but under an hour, with nothing to decide midway: in the background, so the person can keep talking to you: `delegate` with `background: true` for yours, `ask_agent` with `background: true` for theirs. The result comes to you as a message; report it when it arrives. A helper has the hour a reply has, so work that may run past it is a mission's.");
  });

  test("more than about an hour, with little from the person: a mission, which keeps going on its own; another agent's too", () => {
    const text = all();
    expect(text).toContain("  - Long work, more than about an hour, that goes on with little from the person goes to a mission: long development, a deep analysis, a long scan or sweep, research across many sources, a migration");
    expect(text).toContain("keeps going on its own (it works around what fails and proves itself done with checks) and is signed off. `agent` names who does it when it is another agent's work.");
  });

  test("in that order: here, another agent, the background, a mission", () => {
    const text = all();
    const at = (words: string) => text.indexOf(words);
    expect(at("A few minutes, and yours")).toBeLessThan(at("Another agent's"));
    expect(at("Another agent's")).toBeLessThan(at("Longer, but under an hour"));
    expect(at("Longer, but under an hour")).toBeLessThan(at("Long work, more than about an hour"));
  });

  test("each line only where the agent holds what it names", () => {
    const helperOnly = harness(["delegate"], { background: 2 });
    expect(helperOnly).toContain("`delegate` with `background: true` for yours.");
    expect(helperOnly).not.toContain("ask_agent");
    expect(helperOnly).not.toContain("a mission's");
    const askOnly = harness(["ask_agent"], { background: 1 });
    expect(askOnly).toContain("`ask_agent` with `background: true` for theirs.");
    expect(askOnly).not.toContain("`delegate`");
    const noBackground = harness(["delegate", "ask_agent", "mission"], { missions: true, background: 0 });
    expect(noBackground).not.toContain("Longer, but under an hour");
    expect(noBackground).toContain("Long work, more than about an hour");
    const missionOnly = harness(["mission"], { missions: true });
    expect(missionOnly).toContain("  - A few minutes, and yours: do it here.\n");
    expect(missionOnly).not.toContain("`agent` names who does it");
    // A turn that cannot start a mission (a mission's own, a schedule's) is not sent to one.
    const noMissions = harness(["delegate", "ask_agent", "mission"], { background: 2 });
    expect(noMissions).toContain("Longer, but under an hour");
    expect(noMissions).not.toContain("more than about an hour");
    expect(noMissions).not.toContain("is a mission's");
    expect(harness(["read", "exec"], { background: 2 })).not.toContain("Who does the work");
  });
});
