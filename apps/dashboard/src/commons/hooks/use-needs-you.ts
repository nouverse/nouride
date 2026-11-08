/**
 * What is waiting on the person, counted once (0.8.24): the approvals an agent is blocked on, the missions that wait
 * for an answer, the people asking to talk to the agents, the skills an agent wrote that wait for a review, and, for
 * whoever may decide them, the facts the nightly pass proposes and the documents an agent saved for a collection.
 * Home says the total in its greeting and carries a card for each, the browser tab carries it in its title, and each
 * part is a badge where it is answered: approvals and missions on Work, a request on Access, a skill on Skills, facts
 * and documents on Memory. One source, so they never disagree.
 *
 * The same keys and intervals the pages use, so answering something on its page clears it everywhere. `retry: false`:
 * a daemon with access control off answers 501, one with the reflection loop off an empty queue, and retrying a settled
 * "this is not on" only delays the rest.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type MissionView } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";

export interface NeedsYou {
  approvals: number;
  /** Missions waiting on a person for anything but a tool's approval, which `approvals` already counts. */
  missions: number;
  requests: number;
  skills: number;
  /** Facts the nightly pass proposes, waiting for a yes or a no. An operator's to decide, so counted for one only. */
  facts: number;
  /** Documents an agent saved for a collection, waiting to be added; each collection's, by its id. An operator's too. */
  documents: { collection: string; name: string; count: number }[];
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
  // The Memory page's own keys, so deciding there clears the count here. A minute apart: nothing in them expires.
  const operator = canWrite(useMe().data ?? null);
  const proposals = useQuery({ queryKey: ["memory-proposals"], queryFn: api.memoryProposals, enabled: operator, refetchInterval: 60_000, retry: false });
  const knowledge = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge, enabled: operator, refetchInterval: 60_000, retry: false });
  const collections = (knowledge.data?.collections ?? []).filter((collection) => !collection.archived);
  const pending = useQueries({
    queries: collections.map((collection) => ({
      queryKey: ["knowledge-pending", collection.id],
      queryFn: () => api.pendingDocuments(collection.id),
      enabled: operator,
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  const documents = collections
    .map((collection, at) => ({ collection: collection.id, name: collection.name, count: pending[at]?.data?.pending.length ?? 0 }))
    .filter((one) => one.count > 0);
  const counts = {
    approvals: approvals.data?.pending?.length ?? 0,
    missions: missionsWaiting(missions.data?.missions ?? []).length,
    requests: (access.data?.senders ?? []).filter((sender) => sender.status === "pending").length,
    skills: drafts.data?.pending?.length ?? 0,
    facts: operator ? (proposals.data?.proposals.length ?? 0) : 0,
  };
  const waitingDocuments = operator ? documents : [];
  const total = counts.approvals + counts.missions + counts.requests + counts.skills + counts.facts + waitingDocuments.reduce((sum, one) => sum + one.count, 0);
  return { ...counts, documents: waitingDocuments, total };
}

/** "1 thing needs you", "3 things need you", or null when nothing does. */
export function needsYouWords(total: number): string | null {
  if (total === 0) return null;
  return total === 1 ? "1 thing needs you" : `${total} things need you`;
}
