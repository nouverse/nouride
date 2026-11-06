/**
 * One update check per page load, and nothing else.
 *
 * ## Why it does not re-check on its own
 *
 * It used to, on every mount — so walking between Overview and Chat and back asked the release
 * channel three times, and a transfer in flight asked it once a second. That is the shape that
 * exhausted an hourly API budget in under a minute, and it bought nothing: releases are
 * published a few times a week, and there is a button for the impatient.
 *
 * So the check runs when the app loads and then stays put. `staleTime: Infinity` with every
 * automatic refetch switched off means exactly one request per page load; **Check again** is
 * the only thing that asks for another, and a full browser reload is the other.
 *
 * Three places share the check — the sidebar's version line, the Overview badge, and the update
 * page — and one query key means React Query de-duplicates it and they cannot disagree. That is why
 * it is here and not in `modules/update`: the sidebar and Overview are not the update page. The
 * download's progress and the install are the update page's own (`modules/update/useUpdate.ts`).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, type UpdateStatus } from "@/commons/lib/api";

export const UPDATE_QUERY_KEY = ["update"] as const;

export function useUpdate(): UseQueryResult<UpdateStatus> {
  return useQuery<UpdateStatus>({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: () => api.updateStatus(),
    /**
     * Asked once, when the app loads.
     *
     * Every automatic refetch is off by name rather than by leaving a default in place, because
     * the defaults are the ones that caused the problem: a refetch on mount fires on every
     * navigation, and one on window focus fires every time somebody switches back to the tab.
     */
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    // A failed check must not retry three times behind a spinner: the common failure is a box
    // that cannot reach the channel at all, and the answer to that is a sentence, not a wait.
    retry: false,
  });
}

export type UpdateBadgeState =
  | "checking"
  | "unreachable"
  | "unsupported"
  | "current"
  | "available"
  | "downloading"
  | "ready";

/**
 * The one-word state a badge can show.
 *
 * Three of these used to be one word, "unknown", and it was the wrong word for all of them. The
 * version is never unknown — it is on the daemon and printed two inches away — so a badge
 * saying so next to `v0.3.1` reads as a bug in the thing that is supposed to be reassuring you.
 *
 * What can be unknown is whether there is anything *newer*, and there are three reasons for
 * that which a person acts on differently: the check has not finished (wait), the channel could
 * not be reached (usually a rate limit, or a box with no way out), or this build has no update
 * provider at all (nothing will ever change).
 *
 * `ready` is deliberately distinct from `available` for the same reason: a finished download
 * waiting to be installed is a decision sitting with somebody, and calling that "update
 * available" loses the fact that the waiting part is nearly over.
 */
export function badgeState(status: UpdateStatus | undefined): UpdateBadgeState {
  if (!status) return "checking";
  if (!status.supported) return "unsupported";
  if (status.error || !status.check || !status.download) return "unreachable";
  if (status.download.status === "ready") return "ready";
  if (status.download.status === "downloading" || status.download.status === "paused") return "downloading";
  return status.check.newer ? "available" : "current";
}

/**
 * `basic` is what the build calls itself; **Community** is what a person calls it.
 *
 * Two names for one thing, and the split is deliberate rather than sloppy: the build flag and
 * the artifact names are machine identifiers that appear in URLs and CI, and the word somebody
 * reads on a dashboard should be the name of the edition they were given. Nothing user-facing
 * ever says `basic`, and nothing machine-facing ever says `Community`.
 *
 * The three are the whole set. During an update this page can be talking to the build before, which is 0.8.0 or
 * later and says one of them too; an edition this does not know is shown as it is, not hidden.
 */
export function editionLabel(edition: string): string {
  if (edition === "basic") return "Community";
  if (edition === "router") return "Router";
  if (edition === "pro") return "Pro";
  return edition;
}
