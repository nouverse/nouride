/**
 * One job's recent runs, opened under its row — and a run still going, followed until it ends.
 *
 * Out of the page because it is its own query and its own polling, and the page was over its line cap.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock, RotateCcw } from "lucide-react";
import { api } from "@/commons/lib/api";
import { RunResult } from "@/commons/components/jobs/RunResult";
import { HeldActions } from "@/commons/components/jobs/Allowances";
import { TextLoading } from "@/commons/components/ui/Skeleton";

/** Local time in the daemon's zone */
export function inZone(ms: number | undefined, timezone: string): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("sv-SE", { timeZone: timezone });
}

/**
 * How many runs the box is tall enough to show before it scrolls.
 *
 * Ten, because that is roughly a fortnight of a daily job and a couple of hours of a frequent one —
 * enough to see a pattern without the card taking over the page. The daemon still sends twenty.
 */
const VISIBLE_RUNS = 10;

export function Runs({ id, timezone, canEdit }: { id: string; timezone: string; canEdit: boolean }) {
  const detail = useQuery({
    queryKey: ["cron", id],
    queryFn: () => api.cronJob(id),
    // A run still going is asked about until it ends, so how it ended appears without a reload.
    refetchInterval: (query) => (query.state.data?.runs.some((run) => run.status === "running") ? 2_000 : false),
  });

  if (detail.isLoading) return <TextLoading lines={2} className="max-w-sm py-2" />;
  const runs = detail.data?.runs ?? [];
  if (runs.length === 0) return <p className="text-base-content/65 text-xs py-2">No execution runs recorded yet.</p>;

  return (
    <div className="border-t border-base-content/10 pt-3 mt-2 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
          Recent Execution History
        </p>
        <span className="text-[10px] text-base-content/65">
          last {Math.min(runs.length, VISIBLE_RUNS)} of {runs.length} · scroll for older
        </span>
      </div>
      {/*
        Ten rows tall, and it scrolls inside itself.
        A job with 17 runs pushed every card below it off the screen — open two of them and the page
        was a thousand pixels of history nobody had asked to read. The list is still all of it; the
        box is just the height of the part worth seeing at once.
      */}
      <div className="max-h-[268px] overflow-y-auto space-y-1.5 pr-1">
        {runs.map((run) => (
          <div key={run.id} className="flex items-start gap-2.5 text-xs p-2 rounded-lg bg-base-200/40">
            {run.status === "running" ? (
              <span className="loading loading-spinner loading-xs mt-0.5 shrink-0 text-primary" aria-label="running" />
            ) : run.status === "success" ? (
              <Check size={14} className="text-success mt-0.5 shrink-0" />
            ) : run.status === "skipped" ? (
              <Clock size={14} className="mt-0.5 shrink-0 text-base-content/40" />
            ) : run.status === "interrupted" ? (
              // Cut off by a restart: nothing about the job failed, so not the error mark.
              <RotateCcw size={14} className="mt-0.5 shrink-0 text-warning" aria-label="cut off by a restart" />
            ) : (
              <AlertTriangle size={14} className="text-error mt-0.5 shrink-0" />
            )}
            <span className="font-mono text-base-content/65 shrink-0">{inZone(run.startedAt, timezone)}</span>
            <span className="min-w-0 flex-1 text-base-content/85 font-mono text-[11px]">
              <span className="block truncate">{run.status === "running" ? "running…" : <RunResult text={run.result ?? ""} />}</span>
              {run.held?.length ? <HeldActions jobId={id} held={run.held} canEdit={canEdit} /> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
