/**
 * How many missions run at once on the box: `max_running` unset is what the machine has room for, never more than the
 * agents that are on could run; set, it is what was set, as high as every agent at its `per_agent`.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { autoRunning, inForce, inForceFor, mostRunning } from "@/modules/missions/slots.ts";

/** `n` agents that are on, by id. */
const agents = (n: number) => Array.from({ length: n }, (_, at) => `agent-${at}`);

describe("the slots on the box", () => {
  test("unset: what the machine has room for, whatever the number of agents past it", () => {
    // A machine with room for four: four on a box of six, and still four on a box of thirty.
    expect([4, 6, 30].map((n) => autoRunning(4, agents(n).map(() => 1)))).toEqual([4, 4, 4]);
    // A small machine runs one, however many agents it has.
    expect([1, 6, 30].map((n) => autoRunning(1, agents(n).map(() => 1)))).toEqual([1, 1, 1]);
  });

  test("unset: never more than the agents could run, every one at its own per_agent; a box with none still has one", () => {
    expect(autoRunning(4, [1])).toBe(1);
    expect(autoRunning(4, [1, 1])).toBe(2);
    expect(autoRunning(4, [3])).toBe(3);
    expect(autoRunning(4, [])).toBe(1);
  });

  test("the most it may be set to is every agent at its own per_agent at once — and a box with no agent still has one", () => {
    expect(mostRunning(Array.from({ length: 30 }, () => 1))).toBe(30);
    expect(mostRunning(Array.from({ length: 6 }, () => 2))).toBe(12);
    // One agent at its own four (0.8.11), two at the daemon's one.
    expect(mostRunning([4, 1, 1])).toBe(6);
    expect(mostRunning([])).toBe(1);
  });

  test("in force: what was set, or the machine's while unset, said as such — the rest of [missions] as it is", () => {
    const missions = structuredClone(DEFAULT_CONFIG.missions);
    expect(inForce(missions, 4, agents(6))).toMatchObject({ ...missions, maxRunning: 4, auto: true });
    expect(inForce(missions, 2, agents(6))).toMatchObject({ maxRunning: 2, auto: true });
    // A set value wins over the machine both ways: above what it would give, and below.
    expect(inForce({ ...missions, maxRunning: 5 }, 2, agents(6))).toMatchObject({ maxRunning: 5, auto: false });
    expect(inForce({ ...missions, maxRunning: 1 }, 4, agents(30))).toMatchObject({ maxRunning: 1, auto: false });
  });

  test("each agent's own slots: its pack's per_agent where it names one, the daemon's otherwise (0.8.11)", () => {
    const missions = { ...structuredClone(DEFAULT_CONFIG.missions), perAgent: 1 };
    const slots = inForce(missions, 4, ["nix", "nouva"], (agentId) => (agentId === "nix" ? 4 : undefined));
    expect(slots.slotsOf?.("nix")).toBe(4);
    expect(slots.slotsOf?.("nouva")).toBe(1);
    expect(inForce({ ...missions, perAgent: 2 }, 4, agents(6)).slotsOf?.("nouva")).toBe(2);
    // Unset, the box's slots count each agent at its own: one agent at its own three is three.
    expect(inForce(missions, 4, ["nix"], () => 3).maxRunning).toBe(3);
  });

  test("as the dispatcher reads them: the machine, the agents that are on, each by its pack as loaded now", () => {
    const packs: Record<string, { config: { id: string; missionsPerAgent?: number } }> = { nix: { config: { id: "nix", missionsPerAgent: 3 } }, nouva: { config: { id: "nouva" } } };
    const registry = { enabled: () => Object.values(packs), get: (agentId: string) => packs[agentId] };
    const slots = inForceFor(structuredClone(DEFAULT_CONFIG.missions), 4, registry);
    expect(slots.maxRunning).toBe(4);
    expect(slots.slotsOf?.("nix")).toBe(3);
    expect(slots.slotsOf?.("nouva")).toBe(1);
    // Saved from its page, the pack is reloaded: the next decision reads the new number.
    packs.nix = { config: { id: "nix", missionsPerAgent: 4 } };
    expect(slots.slotsOf?.("nix")).toBe(4);
    // One agent turned off, on a machine with room for four: the one left runs its one.
    delete packs.nix;
    expect(inForceFor(structuredClone(DEFAULT_CONFIG.missions), 4, registry).maxRunning).toBe(1);
  });
});
