/**
 * A conversation's work notes, read for the Notes panel and the count on its toggle.
 *
 * Read on load, when the panel is opened, and when a turn ends — `use-conversation.ts` invalidates {@link notesKey}
 * where it folds a finished turn into the transcript, since a turn is when the agent writes them. Never on a timer: the
 * live loop is what polls, and notes change only inside a turn.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";

/** The query's key — one place, so the page's reader and the turn's end name the same cache entry. */
export const notesKey = (sessionId: string | undefined) => ["notes", sessionId ?? ""] as const;

export function useWorkNotes(sessionId: string | undefined) {
  return useQuery({
    queryKey: notesKey(sessionId),
    queryFn: () => api.notes(sessionId!),
    // A conversation not created yet has none, and a room has a session per member — the panel is a one-to-one chat's.
    enabled: Boolean(sessionId),
    // A daemon that keeps none (501), or one older than the route (404), answers the same way every time.
    retry: false,
    staleTime: 30_000,
  });
}
