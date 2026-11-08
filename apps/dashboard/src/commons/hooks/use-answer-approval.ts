/**
 * Answering a tool call that waits for a human — the one mutation Overview and the chat both use, and what it says.
 *
 * Each page had its own copy. The chat's said nothing at all when an answer failed, and the daemon's 409 — the
 * request was answered elsewhere or had timed out, so this answer changed nothing — looked exactly like a successful
 * Allow: the card vanished on the next poll either way. Overview did show the error, inside the card the same poll
 * removed a few seconds later.
 *
 * So the outcome is a toast, which outlives the card it was about: a failure stays until it is dismissed, a 409 is
 * said in words rather than as "not pending", and an answer that landed says which one it was.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { ApprovalDecision, ApprovalRequest } from "@nouride/wire";
import { ApiError } from "@/commons/lib/api.client";
import { useToast } from "@/commons/components/ui/toast";

const ANSWERED: Record<ApprovalDecision, string> = {
  "allow-once": "Allowed once",
  "allow-always": "Allowed, and remembered for next time",
  deny: "Denied",
};

/** Why an answer did not land, for the person who gave it: a 409 in words of its own, anything else as it was said. */
function answerFailure(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 409) {
    return "This request was already answered or has expired; your answer was not applied.";
  }
  return error;
}

export function useAnswerApproval() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { request: ApprovalRequest; decision: ApprovalDecision }) =>
      api.answerApproval(input.request.id, input.decision),
    onSuccess: (_answer, { request, decision }) => toast.success(ANSWERED[decision], request.tool),
    onError: (error, { request }) => toast.error(`Could not answer ${request.tool}`, answerFailure(error)),
    // Either way the list is asked again: a 409 means the request is gone, and the card should go with it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}
