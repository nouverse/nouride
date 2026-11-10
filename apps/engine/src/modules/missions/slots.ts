/**
 * How many missions run at once on the box. `[missions] max_running` unset follows the machine: what its cores and
 * memory have room for, four at most (`commons/machine.ts`), and never more than its agents could run, every one at its
 * own `per_agent`. It was half the agents whatever the machine: three on a box of six, on a phone as on a server. A
 * person may set it as high as every agent running its `per_agent` at once: more than that could never run.
 *
 * Counted over the agents that are on, at every decision, so adding or turning off an agent moves it with no save.
 */

import type { MissionsSection } from "@nouride/shared";
import { atOnceBy, machineWords, type Machine, type MachineFacts } from "@/commons/machine.ts";

/**
 * The most `max_running` may be set to: every agent at its own `per_agent` at once — `slots`, one for each agent that is
 * on. At least one, as a box with none still has a slot.
 */
export function mostRunning(slots: readonly number[]): number {
  return Math.max(1, slots.reduce((sum, one) => sum + one, 0));
}

/** `max_running` unset: what the machine has room for (`byMachine`), held to what the agents could run. */
export function autoRunning(byMachine: number, slots: readonly number[]): number {
  return Math.max(1, Math.min(byMachine, mostRunning(slots)));
}

/**
 * `[missions]` as the dispatcher keeps to it: the slots on the box always a number — the one set, or the machine's
 * (`auto`) — and each agent's own (0.8.11): its pack's `[missions] per_agent` where it names one, the daemon's otherwise.
 */
export type MissionsInForce = MissionsSection & { maxRunning: number; auto?: boolean; slotsOf?: (agentId: string) => number };

/**
 * `byMachine`: what the machine gives while nothing is set. `agents`: the agents that are on. `own`: an agent's pack's
 * `per_agent`, or undefined where it follows the daemon's. Read at each decision.
 */
export function inForce(missions: MissionsSection, byMachine: number, agents: readonly string[], own: (agentId: string) => number | undefined = () => undefined): MissionsInForce {
  const slotsOf = (agentId: string) => own(agentId) ?? missions.perAgent;
  return { ...missions, maxRunning: missions.maxRunning ?? autoRunning(byMachine, agents.map(slotsOf)), auto: missions.maxRunning === undefined, slotsOf };
}

/** An agent as the slots read it: its pack's own `per_agent`, where it names one. */
interface PackSlots {
  config: { id: string; missionsPerAgent?: number };
}

/**
 * What the dispatcher keeps to at each decision (`boot/missions.ts`): `[missions]`, the machine, the agents that are on,
 * and each agent's own `per_agent` as its pack is loaded now — a save from its Settings page reloads the pack.
 */
export function inForceFor(missions: MissionsSection, byMachine: number, registry: { enabled(): readonly PackSlots[]; get(agentId: string): PackSlots | undefined }): MissionsInForce {
  return inForce(missions, byMachine, registry.enabled().map((agent) => agent.config.id), (agentId) => registry.get(agentId)?.config.missionsPerAgent);
}

/**
 * The machine as `agentId`'s prompt says it: its cores and memory in words, the missions it runs at once, and how many
 * of those may be this agent's, which is never more than the box runs. Read from the machine as boot found it and from
 * the config, so the same on every turn.
 */
export function machineFacts(machine: Machine, missions: MissionsSection, registry: Parameters<typeof inForceFor>[2], agentId: string): MachineFacts {
  const slots = inForceFor(missions, atOnceBy(machine), registry);
  return { words: machineWords(machine), missions: { atOnce: slots.maxRunning, own: Math.min(slots.maxRunning, slots.slotsOf?.(agentId) ?? slots.perAgent) } };
}
