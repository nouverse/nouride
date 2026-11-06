/**
 * What an agent is doing, as a badge: waiting for you, working, paused or idle — and, beside it, why it could not work
 * if asked. From `/status`'s `activity` (0.7.18); a daemon before that sends only the pack's state, which is shown as
 * it was.
 */

import type { AgentSummary } from "@/commons/lib/api";

type Tone = "warning" | "primary" | "success" | "ghost" | "error";

const TONE: Record<Tone, string> = {
  warning: "badge-warning",
  primary: "badge-primary",
  success: "badge-success",
  ghost: "badge-ghost",
  error: "badge-error",
};

/** The badge's words, colour and hover text for one agent. */
export function statusBadge(agent: Pick<AgentSummary, "state" | "activity">): { label: string; tone: Tone; title: string } {
  const activity = agent.activity;
  if (!activity) return { label: agent.state, tone: agent.state === "running" ? "success" : agent.state === "error" ? "error" : "ghost", title: agent.state };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  switch (activity.activity) {
    case "waiting":
      return {
        label: "waiting for you",
        tone: "warning",
        title: `${[activity.waiting > 0 ? plural(activity.waiting, "approval") : "", (activity.missionsWaiting ?? 0) > 0 ? plural(activity.missionsWaiting ?? 0, "mission") : ""].filter(Boolean).join(", ") || plural(0, "approval")} waiting on a person`,
      };
    case "working":
      return {
        label: "working",
        tone: "primary",
        title: [activity.working.length > 0 ? `in ${plural(activity.working.length, "chat")}` : "", activity.jobs > 0 ? plural(activity.jobs, "background job") : "", (activity.missions ?? 0) > 0 ? `on ${plural(activity.missions ?? 0, "mission")}` : ""].filter(Boolean).join(", "),
      };
    case "asleep":
      return { label: "asleep", tone: "ghost", title: "Takes no work from anywhere until someone wakes it" };
    default:
      return { label: "idle", tone: "success", title: "Awake, nothing running" };
  }
}

export function AgentStatusBadge({ agent }: { agent: Pick<AgentSummary, "state" | "activity"> }) {
  const badge = statusBadge(agent);
  const unavailable = agent.activity?.unavailable;
  return (
    <>
      <span className={`badge badge-sm font-mono font-semibold ${TONE[badge.tone]}`} title={badge.title}>
        {badge.label}
      </span>
      {unavailable ? (
        <span className="badge badge-sm badge-error badge-outline font-mono font-semibold" title={`Could not work if asked: ${unavailable}`}>
          unavailable
        </span>
      ) : null}
    </>
  );
}
