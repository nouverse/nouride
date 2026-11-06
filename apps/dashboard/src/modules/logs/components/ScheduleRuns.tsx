/** System Logs → Schedule: what the scheduler fired across every job, and what came back. */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState } from "@/commons/components/ui/ui";
import { Panel } from "./Panel";

export function ScheduleRuns() {
  const runs = useQuery({
    // Not `["cron", "runs"]`: `["cron", <id>]` is a job's detail, and a literal segment that could
    // ever be mistaken for an id is a collision waiting for the day somebody changes the id format.
    queryKey: ["cron", "recent-runs"],
    queryFn: () => api.cronRuns(200),
    refetchInterval: 10_000,
    retry: false,
  });

  if (runs.error) {
    return (
      <Card className="shrink-0">
        <EmptyState icon={Clock} title="The scheduler is not enabled on this daemon" />
      </Card>
    );
  }

  const list = runs.data?.runs ?? [];
  const timezone = runs.data?.timezone ?? "UTC";

  return (
    <Panel
      title="Scheduler runs"
      retention="cronRuns"
      description={`Every firing across every job, newest first. Times in ${timezone}.`}
    >
      {runs.isPending ? (
        <div className="flex justify-center py-12">
          <Loader2 size={20} className="animate-spin text-primary/60" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={Clock} title="Nothing has fired yet" />
      ) : (
        <div className="space-y-1">
          {list.map((run) => (
            <div
              key={run.id}
              className={`flex flex-wrap items-start gap-2 rounded-lg px-2 py-1.5 text-xs ${
                run.status === "error" ? "bg-error/[0.05]" : "hover:bg-base-200/50"
              }`}
            >
              {run.status === "success" ? (
                <Check size={13} className="text-success mt-0.5 shrink-0" />
              ) : run.status === "skipped" ? (
                <Clock size={13} className="mt-0.5 shrink-0 text-base-content/40" />
              ) : run.status === "interrupted" ? (
                <RotateCcw size={13} className="mt-0.5 shrink-0 text-warning" aria-label="interrupted by a daemon restart" />
              ) : (
                <AlertTriangle size={13} className="text-error mt-0.5 shrink-0" />
              )}
              <span className="font-mono text-[10px] text-base-content/65 shrink-0 tabular-nums sm:w-[128px]">
                {new Date(run.startedAt).toLocaleString([], { hour12: false, timeZone: timezone })}
              </span>
              <span className="font-semibold text-base-content/85 shrink-0 truncate max-w-[180px]">
                {run.jobName}
              </span>
              <span className="font-mono text-[10px] text-base-content/65 shrink-0">
                {run.agentId}
                {run.finishedAt ? ` · ${Math.max(0, run.finishedAt - run.startedAt)}ms` : " · running"}
              </span>
              {/* The whole width under the rest on a phone, where it was a narrow column beside a fixed-width time. */}
              <span className="min-w-0 flex-1 font-mono text-[11px] text-base-content/65 break-words max-sm:basis-full max-sm:pl-[21px]">
                {run.result ?? ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
