/**
 * How many missions run at once on the box (decided 2026-10-25). `[missions] max_running` unset follows the agents:
 * half of them, rounded down — a box of one or two runs one, of six three — and never more than eight, however many
 * there are. A person may set it as high as every agent running its `per_agent` at once: more than that could never run.
 *
 * Counted over the agents that are on, at every decision, so adding or turning off an agent moves it with no save.
 */

import type { MissionsSection } from "@nouride/shared";

/** What the unset setting stops at, however many agents there are. */
const AUTO_RUNNING_MOST = 8;

/** `max_running` unset: half the agents, rounded down, from one to {@link AUTO_RUNNING_MOST}. */
export function autoRunning(agents: number): number {
  return Math.min(AUTO_RUNNING_MOST, Math.max(1, Math.floor(agents / 2)));
}

/**
 * The most `max_running` may be set to: every agent at its own `per_agent` at once — `slots`, one for each agent that is
 * on. At least one, as a box with none still has a slot.
 */
export function mostRunning(slots: readonly number[]): number {
  return Math.max(1, slots.reduce((sum, one) => sum + one, 0));
}

/**
 * `[missions]` as the dispatcher keeps to it: the slots on the box always a number — the one set, or the agents' half —
 * and each agent's own (0.8.11): its pack's `[missions] per_agent` where it names one, the daemon's otherwise.
 */
export type MissionsInForce = MissionsSection & { maxRunning: number; slotsOf?: (agentId: string) => number };

/** `own`: an agent's pack's `per_agent`, or undefined where it follows the daemon's. Read at each decision, as `agents` is. */
export function inForce(missions: MissionsSection, agents: number, own: (agentId: string) => number | undefined = () => undefined): MissionsInForce {
  return { ...missions, maxRunning: missions.maxRunning ?? autoRunning(agents), slotsOf: (agentId) => own(agentId) ?? missions.perAgent };
}

/** An agent as the slots read it: its pack's own `per_agent`, where it names one. */
interface PackSlots {
  config: { missionsPerAgent?: number };
}

/**
 * What the dispatcher keeps to at each decision (`boot/missions.ts`): `[missions]`, the agents that are on, and each
 * agent's own `per_agent` as its pack is loaded now — a save from its Settings page reloads the pack.
 */
export function inForceFor(missions: MissionsSection, registry: { enabled(): readonly PackSlots[]; get(agentId: string): PackSlots | undefined }): MissionsInForce {
  return inForce(missions, registry.enabled().length, (agentId) => registry.get(agentId)?.config.missionsPerAgent);
}
