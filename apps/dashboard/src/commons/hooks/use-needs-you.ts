/**
 * What is waiting on the person, counted once (0.8.24): the approvals an agent is blocked on, the missions that wait
 * for an answer, the people asking to talk to the agents, and the skills an agent wrote that wait for a review. Home
 * says the total in its greeting, the browser tab carries it in its title, and each part is a badge where it is
 * answered: approvals and missions on Work, a request on Access, a skill on Skills. One source, so they never disagree.
 *
 * The same keys and intervals the pages use, so answering something on its page clears it everywhere. `retry: false`:
 * a daemon with access control off answers 501, one with the reflection loop off an empty queue, and retrying a settled
 * "this is not on" only delays the rest.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type MissionView } from "@/commons/lib/api";

export interface NeedsYou {
  approvals: number;
  /** Missions waiting on a person for anything but a tool's approval, which `approvals` already counts. */
  missions: number;
  requests: number;
  skills: number;
  total: number;
}

/** The week's missions, as Home and the count read them: under `["missions"]`, so a change to one refreshes it. */
export const MOVING_MISSIONS = ["missions", "home"] as const;

/** The missions waiting on a person for anything but a tool's approval, which is counted, and answered, as one. */
export function missionsWaiting<T extends Pick<MissionView, "seen" | "waitKind">>(missions: readonly T[]): T[] {
  return missions.filter((mission) => mission.seen === "needs_you" && mission.waitKind !== "approval");
}

export function useNeedsYou(): NeedsYou {
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 5_000, retry: false });
  const access = useQuery({ queryKey: ["access"], queryFn: api.access, refetchInterval: 15_000, retry: false });
  const drafts = useQuery({ queryKey: ["skill-drafts"], queryFn: api.skillDrafts, refetchInterval: 30_000, retry: false });
  const missions = useQuery({ queryKey: MOVING_MISSIONS, queryFn: () => api.missions(), refetchInterval: 15_000, retry: false });
  const counts = {
    approvals: approvals.data?.pending?.length ?? 0,
    missions: missionsWaiting(missions.data?.missions ?? []).length,
    requests: (access.data?.senders ?? []).filter((sender) => sender.status === "pending").length,
    skills: drafts.data?.pending?.length ?? 0,
  };
  return { ...counts, total: counts.approvals + counts.missions + counts.requests + counts.skills };
}

/** "1 thing needs you", "3 things need you", or null when nothing does. */
export function needsYouWords(total: number): string | null {
  if (total === 0) return null;
  return total === 1 ? "1 thing needs you" : `${total} things need you`;
}
