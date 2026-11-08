/**
 * The update page's own questions: how far a download has got, and the install.
 *
 * The check itself — whether there is anything newer — is asked once per page load and shared with
 * the sidebar and Home, so it lives in `commons/hooks/use-update.ts`.
 *
 * ## Progress is a different question
 *
 * While a download runs the page has to move, and that reading is polled once a second — from
 * `/update/progress`, which reads a counter and touches no channel. Two questions asked at two
 * rates, which is what they were all along.
 */

import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { UpdateDownload } from "@nouride/wire";

export const UPDATE_PROGRESS_KEY = ["update", "progress"] as const;

/** While a transfer is running the page has to move; the rest of the time it does not. */
const WHILE_DOWNLOADING_MS = 1_000;

/**
 * The transfer's own counter, which decides for itself whether to keep asking.
 *
 * Driven by its **own** last answer rather than by a flag from the check. That was the first
 * shape and it deadlocked: the check is frozen after page load, so the flag it carried said
 * "idle" for ever, the poll never started, and pressing Download produced a bar that never
 * moved. The server is the thing that knows whether bytes are arriving, so the server's answer
 * is what decides whether to ask again.
 *
 * One cheap request on mount, then one a second only while something is actually downloading.
 */
export function useDownloadProgress(): UseQueryResult<{ download: UpdateDownload }> {
  return useQuery<{ download: UpdateDownload }>({
    queryKey: UPDATE_PROGRESS_KEY,
    queryFn: api.updateProgress,
    refetchInterval: (query) =>
      query.state.data?.download?.status === "downloading" ? WHILE_DOWNLOADING_MS : false,
    retry: false,
  });
}

/**
 * Install: the daemon is about to stop answering, and what happens next is `RestartingCard`'s job.
 *
 * No invalidation here: a refetch fired at the moment of the swap lands in the gap and errors for no purpose. The card
 * polls, which is the same work done at a rhythm that matches how long a restart takes. The uptime first, so the card
 * can tell the process that installed from the one that comes back.
 */
export function useInstall() {
  return useMutation({
    mutationFn: async () => {
      const before = await api.health().then((health) => health.uptime).catch(() => null);
      return { ...(await api.installUpdate()), before };
    },
  });
}
