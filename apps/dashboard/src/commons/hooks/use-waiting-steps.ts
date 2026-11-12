/**
 * The steps of automations that wait for a person, and the answer to one. Read once for every place that shows them
 * (Waiting for you, Home, the menu's count, an automation's own page), under one key, so an answer given in one clears
 * it in all of them.
 *
 * The answer's outcome is a toast, as an approval's is: the card it was given on goes with the next poll, and a
 * refusal (the step no longer waits: answered in its chat, or its time ran out) must not read as a Continue.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";

const WAITING_STEPS = ["automations", "waiting"] as const;

export function useWaitingSteps() {
  return useQuery({ queryKey: WAITING_STEPS, queryFn: api.waitingSteps, refetchInterval: 5_000, retry: false });
}

export function useAnswerStep() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (answer: { runId: string; go: boolean; name: string }) => api.answerStep(answer.runId, answer.go),
    onSuccess: (_answer, { go, name }) => toast.success(go ? "Continued" : "Stopped", name),
    onError: (error, { name }) => toast.error(`Could not answer ${name}`, error),
    // Either way everything about automations is asked again: a refusal means the step no longer waits.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}
