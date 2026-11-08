/**
 * A job an agent proposed, waiting for a person (0.8.0): who proposed it, and Turn on and Discard — on the Schedule and
 * Webhooks pages, which list the same jobs. Its card in the chat it was asked in says the same, and follows an answer
 * given here.
 */

import { useMutation } from "@tanstack/react-query";
import { Power, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { JobSummary } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";

export function ProposalBar({ job, canAnswer, onAnswered }: { job: Pick<JobSummary, "id" | "name" | "proposal">; canAnswer: boolean; onAnswered: () => void }) {
  const turnOn = useMutation({ mutationFn: () => api.cronAction(job.id, "enable"), onSuccess: onAnswered });
  const discard = useMutation({ mutationFn: () => api.cronDelete(job.id), onSuccess: onAnswered });
  if (!job.proposal) return null;
  const busy = turnOn.isPending || discard.isPending;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="badge badge-sm badge-info badge-soft font-medium font-mono">
          Proposed by {job.proposal.by}
          {job.proposal.replaces ? ` · changes ${job.proposal.replaces}` : ""}
        </span>
        <button type="button" className="btn btn-primary btn-xs rounded-lg gap-1" disabled={!canAnswer || busy} onClick={() => turnOn.mutate()}>
          <Power size={13} aria-hidden="true" /> Turn on
        </button>
        <button type="button" className="btn btn-ghost btn-xs rounded-lg gap-1 text-error hover:bg-error/10" disabled={!canAnswer || busy} onClick={() => discard.mutate()}>
          <Trash2 size={13} aria-hidden="true" /> Discard
        </button>
      </div>
      <p className="text-[11px] text-base-content/65">It stays off until somebody turns it on.</p>
      <ErrorNote error={turnOn.error ?? discard.error} />
    </div>
  );
}
