/**
 * Where an agent's cat is, from its status: the Office and Home's agents read it the same way.
 */

import type { AgentSummary } from "@/commons/lib/api";
import type { Status } from "./layout";

export function statusOf(agent: Pick<AgentSummary, "activity" | "state">): Status {
  const activity = agent.activity?.activity;
  if (activity === "working" || activity === "waiting" || activity === "asleep") return activity;
  // One that cannot work (its pack failed or is off, its CLI not signed in, no key) is in bed, not on the sofa with an
  // alert over it (the owner, 2026-11-03): it is not there to be asked. Why stays on its card and in its label.
  if (agent.activity?.unavailable) return "asleep";
  if (activity === "idle") return "idle";
  return agent.state === "paused" ? "asleep" : "idle";
}
