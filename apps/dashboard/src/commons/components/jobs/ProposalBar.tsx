/**
 * An automation an agent proposed, waiting for a person: Turn on and Discard, on its row in the list and at the head
 * of its own page. It stays off until somebody turns it on; its card in the chat it was asked in says the same, and
 * follows an answer given here. A failure is a toast: the row it was pressed on may be gone by the next poll.
 */

import { useMutation } from "@tanstack/react-query";
import { Power, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { JobSummary } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";

export function ProposalBar({ job, canAnswer, onAnswered }: { job: Pick<JobSummary, "id" | "name" | "proposal">; canAnswer: boolean; onAnswered: (turnedOn: boolean) => void }) {
  const toast = useToast();
  const turnOn = useMutation({
    mutationFn: () => api.cronAction(job.id, "enable"),
    onSuccess: () => {
      toast.success(`${job.name} is on`);
      onAnswered(true);
    },
    onError: (error) => toast.error(`Could not turn on ${job.name}`, error),
  });
  const discard = useMutation({
    mutationFn: () => api.cronDelete(job.id),
    onSuccess: () => onAnswered(false),
    onError: (error) => toast.error(`Could not discard ${job.name}`, error),
  });
  if (!job.proposal) return null;
  const busy = turnOn.isPending || discard.isPending;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary btn-sm gap-1.5" disabled={!canAnswer || busy} onClick={() => turnOn.mutate()}>
        <Power size={14} aria-hidden="true" /> Turn on
      </button>
      <button type="button" className="btn btn-ghost btn-sm gap-1.5 border border-base-content/10" disabled={!canAnswer || busy} onClick={() => discard.mutate()}>
        <Trash2 size={14} aria-hidden="true" /> Discard
      </button>
    </div>
  );
}
