/**
 * What an agent is doing right now, as `/status` carries it, and the few words that say it: the same in the chat's
 * status and in `nouride agents`. How it is worked out is the daemon's (`pipeline/agent-status.ts`).
 */

import { plural } from "./text.ts";

export type AgentActivity = "waiting" | "working" | "asleep" | "idle";

export interface AgentStatus {
  activity: AgentActivity;
  /** The conversations it has a turn running in. */
  working: { gatewayId: string; chatId: string }[];
  /** Its background jobs running: commands and helpers, and a command its coding CLI left running (0.8.15). */
  jobs: number;
  /** Its missions at work, between their turns too (0.8.15). */
  missions: number;
  /** Its missions waiting for a person: a question, stuck, a limit, a result to accept (0.8.15). */
  missionsWaiting: number;
  /** Its approvals waiting on a person. */
  waiting: number;
  /** Why it could not work if asked, or null. */
  unavailable: string | null;
}

/** The status in a few words, the same in `/status` and `nouride agents`: "working (in 2 chats, 1 job)". */
export function describeStatus(status: AgentStatus): string {
  const count = (n: number, one: string) => `${n} ${plural(n, one)}`;
  const detail =
    status.activity === "waiting"
      ? ` (${[status.waiting > 0 ? count(status.waiting, "approval") : "", status.missionsWaiting > 0 ? count(status.missionsWaiting, "mission") : ""].filter(Boolean).join(", ")})`
      : status.activity === "working"
        ? ` (${[status.working.length > 0 ? `in ${count(status.working.length, "chat")}` : "", status.jobs > 0 ? count(status.jobs, "job") : "", status.missions > 0 ? count(status.missions, "mission") : ""].filter(Boolean).join(", ")})`
        : "";
  const word = status.activity === "waiting" ? "waiting for you" : status.activity;
  return `${word}${detail}${status.unavailable ? ` · unavailable: ${status.unavailable}` : ""}`;
}
