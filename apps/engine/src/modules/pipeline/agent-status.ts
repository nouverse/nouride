/**
 * What an agent is doing right now (0.7.18) — the half of 0.8.0's agent status that needs nothing stored.
 *
 * The state `/status` carried was the pack's — `running`, `paused`, `error` — so an agent mid-answer, one stuck on a
 * question only a person can answer, and one with nothing to do all read `running`. This is worked out from what the
 * daemon already holds in memory: the turns running, the jobs running, the approvals waiting. Nothing is stored and
 * nothing is polled; a caller asks when it draws.
 *
 * When more than one is true the first wins: an agent working in one chat and waiting in another shows `waiting`,
 * the one only a person can move. `unavailable` is not a status but a reason beside one — the agent could not work
 * even if asked — so a fault is never mistaken for a mode. `asleep` (0.8.0) is the pause mark, which the registry keeps.
 */

import { describeStatus, type AgentActivity, type AgentRuntimeStatus, type AgentStatus, type GatewayPresence } from "@nouride/shared";

export { describeStatus };
export type { AgentActivity, AgentStatus };

export function agentStatus(input: {
  state: AgentRuntimeStatus;
  enabled: boolean;
  turns: readonly { gatewayId: string; chatId: string }[];
  jobs: number;
  /** Its missions at work, and those waiting for a person. */
  missions: { atWork: number; waiting: number };
  waiting: number;
  /** Whether its model's provider holds a credential; null when that is not known. */
  credential: boolean | null;
  /** An external agent's (0.8.1): why its coding CLI cannot answer — not installed, not signed in — or null. */
  cli?: string | null;
}): AgentStatus {
  const unavailable = !input.enabled
    ? "switched off in its pack"
    : input.state === "error"
      ? "its pack failed to load"
      : input.cli
        ? input.cli
        : input.credential === false
          ? "its model's provider has no credential"
          : null;
  const activity: AgentActivity =
    input.waiting > 0 || input.missions.waiting > 0
      ? "waiting"
      : input.turns.length > 0 || input.jobs > 0 || input.missions.atWork > 0
        ? "working"
        : input.state === "paused"
          ? "asleep"
          : "idle";
  // One entry per conversation: two turns in one chat — a reply and a job's wake-up — are one place.
  const working = [...new Map(input.turns.map((turn) => [`${turn.gatewayId}\u0000${turn.chatId}`, { gatewayId: turn.gatewayId, chatId: turn.chatId }])).values()];
  return { activity, working, jobs: input.jobs, missions: input.missions.atWork, missionsWaiting: input.missions.waiting, waiting: input.waiting, unavailable };
}

/** What a bot shows of its agent (0.8.0): online while it works or waits for a person, idle, or do not disturb asleep. */
export function presenceFor(activity: AgentActivity): GatewayPresence {
  return activity === "asleep" ? "dnd" : activity === "idle" ? "idle" : "online";
}

