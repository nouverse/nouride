/**
 * Each agent's colour (`agentTints`): its own, never a grey and never another agent's, its outfit's hue where that one is
 * free, the orchestrator choosing first. The owner looked at a room where one agent's tag was grey and two were the same
 * lilac, and asked where the colour was.
 */

import { describe, expect, test } from "bun:test";
import type { Look } from "@/commons/cat/look";
import { agentTints } from "@/commons/lib/agent-tints";

const look = (outfitColor: string) => ({ outfitColor }) as unknown as Look;
const hueOf = (tint: string | undefined) => tint?.match(/#[0-9a-f]{6}/)?.[0];

describe("each agent's colour", () => {
  test("seven agents, two in one lilac and two in charcoal and white: seven colours, none a grey", () => {
    const agents = [
      { id: "kuro", look: look("lilac") },
      { id: "nero", look: look("peach") },
      { id: "nestor", look: look("charcoal") },
      { id: "nexa", look: look("sage") },
      { id: "nix", look: look("lilac") },
      { id: "nouva", look: look("lilac") },
      { id: "nox", look: look("white") },
    ];
    const tints = agentTints(agents, "nouva");
    const hues = agents.map((agent) => hueOf(tints.get(agent.id)));
    expect(new Set(hues).size).toBe(7);
    for (const grey of ["#33373e", "#c4c7cf", "#4a4f58", "#f4f3ee"]) expect(hues).not.toContain(grey);
    // Drawn toward the text colour, so it reads on either theme.
    expect(tints.get("nix")).toContain("var(--color-base-content)");
  });

  test("an outfit's own hue where it is free, and the orchestrator takes its own first", () => {
    const tints = agentTints([{ id: "kuro", look: look("lilac") }, { id: "nero", look: look("peach") }, { id: "nouva", look: look("lilac") }], "nouva");
    expect(hueOf(tints.get("nero"))).toBe("#e8735a");
    // Kuro sorts first, but the orchestrator chooses before it: the lilac is Nouva's.
    expect(hueOf(tints.get("nouva"))).toBe("#8b6be0");
    expect(hueOf(tints.get("kuro"))).not.toBe("#8b6be0");
  });

  test("past the set's size, hues repeat in order rather than pile on one", () => {
    const agents = Array.from({ length: 9 }, (_, n) => ({ id: `a${n}`, look: look("charcoal") }));
    const hues = agents.map((agent) => hueOf(agentTints(agents).get(agent.id)));
    expect(new Set(hues.slice(0, 8)).size).toBe(8);
    expect(hues[8]).toBe(hues[0]);
  });
});
