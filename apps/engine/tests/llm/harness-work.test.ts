/**
 * "Who does the work" (0.8.17): one block for doing it here, a helper (`delegate`), another agent (`ask_agent`) and a
 * mission, decided by whose work it is and how long it will take. The three lines it replaced, one beside each tool,
 * overlapped, and work of ten minutes was drafted as a mission. The bar between the background
 * and a mission is the hour a reply has. Each line is said only where the agent holds what it names.
 *
 * And the machine under it: its cores and memory and what this turn may have running on it at once, each figure handed
 * in as it was read. A limit is said only to a turn that can use it.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";

/** A 6-core box with 8 GB, its agents' commands in a cgroup of their own: four missions at once, one of this agent's. */
const BOX = { words: "6 cores, 8.0GB of memory (5.9GB of it for the agents' commands)", missions: { atOnce: 4, own: 1 } };

function harness(toolNames: string[], opts: { missions?: boolean; background?: number; machine?: typeof BOX; helper?: boolean } = {}): string {
  return renderTools({
    ctx: {
      harness: {
        maxToolIterations: 8,
        approvalAvailable: true,
        ...(opts.missions ? { startsMissions: true } : {}),
        ...(opts.background === undefined ? {} : { backgroundHelpers: opts.background }),
        ...(opts.machine ? { machine: opts.machine } : {}),
        ...(opts.helper ? { helper: true } : {}),
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

  test("a few minutes and yours: here; independent questions to helpers at once, waited for up to a minute", () => {
    expect(all()).toContain(
      "  - A few minutes, and yours: do it here. Several independent questions you need before you can answer (four hosts to check, three logs to read): `delegate` them in one call; up to four run at once and you wait, up to a minute: a helper still working then moves to the background.",
    );
    // Where none may move — the background off — the wait has no end to name.
    expect(harness(["delegate"], { background: 0 })).toContain("`delegate` them in one call; up to four run at once and you wait.");
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

describe("the machine it runs on", () => {
  const MACHINE = "- **This machine** has 6 cores, 8.0GB of memory (5.9GB of it for the agents' commands), shared by every agent on it.";

  test("its cores and memory, and what this agent may have running at once: helpers and asks in the background, missions on the box and its own", () => {
    const text = harness(["delegate", "ask_agent", "mission", "exec"], { missions: true, background: 4, machine: BOX });
    expect(text).toContain(`${MACHINE} At once: at most 4 of your helpers and asks in the background, and at most 4 missions on this machine (1 of yours).\n`);
    // Read before the two questions it is the ground for.
    expect(text.indexOf("**This machine**")).toBeLessThan(text.indexOf("**Who does the work**"));
  });

  test("each limit only where this turn can use it", () => {
    // No ask_agent: its helpers alone.
    expect(harness(["delegate"], { background: 2, machine: BOX })).toContain(`${MACHINE} At once: at most 2 of your helpers in the background.\n`);
    // The background off: the missions alone, one said as one.
    expect(harness(["delegate", "mission"], { missions: true, background: 0, machine: { ...BOX, missions: { atOnce: 1, own: 1 } } })).toContain(
      `${MACHINE} At once: at most 1 mission on this machine (1 of yours).\n`,
    );
    // A turn that starts no mission (a mission's own, a schedule's) is told nothing of missions.
    const noMissions = harness(["delegate", "ask_agent", "mission"], { background: 2, machine: BOX });
    expect(noMissions).toContain(`${MACHINE} At once: at most 2 of your helpers and asks in the background.\n`);
    expect(noMissions).not.toContain("on this machine (");
  });

  test("a helper is told the machine its commands run on, and no limit: it starts no helper and no mission", () => {
    const text = harness(["read", "exec"], { helper: true, machine: BOX });
    expect(text).toContain(`${MACHINE}\n`);
    expect(text).not.toContain("At once:");
    expect(text).not.toContain("Who does the work");
  });

  test("nothing of it to a turn that can load nothing, or where the daemon was given no machine", () => {
    expect(harness(["read", "web_search"], { machine: BOX })).not.toContain("This machine");
    const unsaid = harness(["delegate", "exec"], { background: 2 });
    expect(unsaid).not.toContain("This machine");
  });
});
