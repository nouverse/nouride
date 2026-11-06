/**
 * How many missions run at once on the box (0.8.0): `max_running` unset is half the agents that are on, rounded down,
 * from one to eight; set, it is what was set, as high as every agent at its `per_agent`.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { autoRunning, inForce, inForceFor, mostRunning } from "@/modules/missions/slots.ts";

describe("the slots on the box", () => {
  test("unset: half the agents, rounded down — one for one, three for six, never past eight", () => {
    const table: [number, number][] = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 3], [16, 8], [17, 8], [30, 8]];
    for (const [agents, slots] of table) expect([agents, autoRunning(agents)]).toEqual([agents, slots]);
  });

  test("the most it may be set to is every agent at its own per_agent at once — and a box with no agent still has one", () => {
    expect(mostRunning(Array.from({ length: 30 }, () => 1))).toBe(30);
    expect(mostRunning(Array.from({ length: 6 }, () => 2))).toBe(12);
    // One agent at its own four (0.8.11), two at the daemon's one.
    expect(mostRunning([4, 1, 1])).toBe(6);
    expect(mostRunning([])).toBe(1);
  });

  test("in force: what was set, or the agents' half while unset — the rest of [missions] as it is", () => {
    const missions = structuredClone(DEFAULT_CONFIG.missions);
    expect(inForce(missions, 6)).toMatchObject({ ...missions, maxRunning: 3 });
    expect(inForce({ ...missions, maxRunning: 5 }, 6).maxRunning).toBe(5);
    expect(inForce({ ...missions, maxRunning: 1 }, 30).maxRunning).toBe(1);
  });

  test("each agent's own slots: its pack's per_agent where it names one, the daemon's otherwise (0.8.11)", () => {
    const missions = { ...structuredClone(DEFAULT_CONFIG.missions), perAgent: 1 };
    const slots = inForce(missions, 6, (agentId) => (agentId === "nix" ? 4 : undefined));
    expect(slots.slotsOf?.("nix")).toBe(4);
    expect(slots.slotsOf?.("nouva")).toBe(1);
    expect(inForce({ ...missions, perAgent: 2 }, 6).slotsOf?.("nouva")).toBe(2);
  });

  test("as the dispatcher reads them: the agents that are on, each by its pack as loaded now", () => {
    const packs: Record<string, { config: { missionsPerAgent?: number } }> = { nix: { config: { missionsPerAgent: 3 } }, nouva: { config: {} } };
    const slots = inForceFor(structuredClone(DEFAULT_CONFIG.missions), { enabled: () => Object.values(packs), get: (agentId) => packs[agentId] });
    expect(slots.slotsOf?.("nix")).toBe(3);
    expect(slots.slotsOf?.("nouva")).toBe(1);
    // Saved from its page, the pack is reloaded: the next decision reads the new number.
    packs.nix = { config: { missionsPerAgent: 4 } };
    expect(slots.slotsOf?.("nix")).toBe(4);
  });
});
