/**
 * *Always for this job* on the dashboard (0.8.0): what a run's guards held with nobody there to ask, each with a button
 * that allows it for the job's runs from now on — and on the job's card, what is allowed, each taken back with a press.
 * One pair for the Schedule and Webhooks pages, which list the same jobs.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { api, type HeldAction, type JobSummary } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";

function useAllowed(jobId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (change: Parameters<typeof api.cronAllowed>[1]) => api.cronAllowed(jobId, change),
    onSuccess: (_answer, change) => {
      for (const key of [["cron", jobId], ["cron"], ["webhooks"]]) void queryClient.invalidateQueries({ queryKey: key });
      toast.show({ message: "add" in change ? "Allowed for this job's runs from now on" : "Taken back: it is asked again", kind: "success" });
    },
    onError: (err) => toast.error("Could not change what this job may send", err),
  });
}

/** What a run's guards held: each with why, and Always allow where it says where it would have sent. */
export function HeldActions({ jobId, held, canEdit }: { jobId: string; held: HeldAction[]; canEdit: boolean }) {
  const allow = useAllowed(jobId);
  return (
    <ul className="mt-1 space-y-1">
      {held.map((one, index) => (
        <li key={`${one.keys.join(" ")}-${index}`} className="flex flex-wrap items-center gap-2 text-[11px]">
          <ShieldAlert size={12} aria-hidden="true" className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-base-content/80">
            Held: {one.label} <span className="text-base-content/65">({one.reason})</span>
          </span>
          {one.keys.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-xs rounded-lg"
              disabled={!canEdit || allow.isPending}
              onClick={() => allow.mutate({ add: { keys: one.keys, label: one.label } })}
            >
              Always allow for this job
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What this job's runs may send without asking — each taken back with a press. Nothing when nothing is. */
export function Allowed({ job, canEdit }: { job: Pick<JobSummary, "id" | "allowed">; canEdit: boolean }) {
  const allow = useAllowed(job.id);
  if (!job.allowed?.length) return null;
  return (
    <div className="space-y-1 text-xs">
      <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">Always allowed for this job</p>
      <ul className="space-y-1">
        {job.allowed.map((one) => (
          <li key={one.keys.join(" ")} className="flex flex-wrap items-center gap-2">
            <ShieldCheck size={12} aria-hidden="true" className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 text-base-content/80">
              {one.label} <span className="text-base-content/65">(by {one.by})</span>
            </span>
            <button type="button" className="btn btn-ghost btn-xs rounded-lg" disabled={!canEdit || allow.isPending} onClick={() => allow.mutate({ remove: one.keys[0]! })}>
              Take back
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
