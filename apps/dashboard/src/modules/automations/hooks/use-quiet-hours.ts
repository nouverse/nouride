/**
 * The quiet hours, read and set. Read under one key by each place that says them (the line on the Automations page,
 * the switch on an automation that tells at once whatever the hour), so what an admin saves is seen in both.
 *
 * A server older than the setting has no answer: the pages then say nothing of the hours.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import { hoursWords } from "../lib/watch";

const QUIET_HOURS = ["quiet-hours"] as const;

/** `wanted`: whether the page has a place that says them now; a card whose fields are closed does not ask. */
export function useQuietHours(wanted = true) {
  return useQuery({ queryKey: QUIET_HOURS, queryFn: api.quietHoursPolicy, staleTime: 60_000, retry: false, enabled: wanted });
}

/** An admin's save: two times, or none. The answer is what is in force from then, and that is what the pages show. */
export function useSetQuietHours() {
  const queryClient = useQueryClient();
  const saved = useSaved();
  return useMutation({
    mutationFn: (hours: { from: string; to: string } | null) => api.setQuietHours(hours),
    onSuccess: (answer) => {
      const { ok: _ok, ...policy } = answer;
      queryClient.setQueryData(QUIET_HOURS, policy);
      const hours = hoursWords(policy);
      saved(answer, hours ? `Quiet hours are ${hours}` : "Quiet hours are off", hours ? "What automations say to a chat then is kept, and sent when the hours end." : "Automations tell their chats at any hour.");
    },
  });
}
