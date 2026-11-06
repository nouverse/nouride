/** The nightly pass, on top of the timeline: when it runs next, what the last run did, and what it could not file. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RotateCcw } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { PassBacklog } from "@/commons/lib/api.memory";
import { useToast } from "@/commons/components/ui/toast";
import { Card } from "@/commons/components/ui/ui";

/**
 * Whether the pass keeps up (M4): said once what waits is more than a week of nights files at the count set, with each
 * agent's pace and the count that would — `modules/memory/backlog.ts` on the daemon. Every number is a count, or an
 * average of counts over the days named.
 */
function BacklogNote({ backlog }: { backlog: PassBacklog }) {
  if (backlog.enough === null) return null;
  const pace = backlog.agents
    .filter((row) => row.perDay > 0)
    .map((row) => `${row.agent || "no agent"} ${row.perDay} a day`)
    .join(", ");
  const over = backlog.days === 7 ? "over the last 7 days" : `over the ${backlog.days} day(s) since the first conversation`;
  return (
    <p className="text-warning text-xs font-medium">
      {backlog.behind.length ? "Falling behind" : "More waiting than a week of nights files"}: {pace || "no conversations lately"} {over}, and the pass
      files {backlog.perNight} per agent a night. Set Conversations per night to {backlog.enough} in Settings to file the {backlog.waiting} waiting
      {backlog.oldest ? ` (the oldest from ${backlog.oldest})` : ""} within a week, and Tokens per night to cap what a night may spend. {/* plain-words-ok: the setting's own name, tokens the unit a model's use is billed in */}
    </p>
  );
}

export function PassCard({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus, refetchInterval: 15_000 });
  const failed = useQuery({ queryKey: ["memory-failed"], queryFn: api.memoryFailed });
  const refresh = async () => {
    for (const key of ["memory-status", "memory-failed", "memory-episodes", "memory-people", "memory-proposals", "memory-changes"]) await queryClient.invalidateQueries({ queryKey: [key] });
  };
  const run = useMutation({
    mutationFn: api.runPass,
    onSuccess: async (report) => {
      toast.success("Nightly pass done", `${report.filed} filed, ${report.applied} fact(s) kept, ${report.proposed} waiting for you.${report.stopped ? ` Stopped: ${report.stopped}` : ""}`);
      await refresh();
    },
    onError: (err) => toast.error("The pass did not run", err),
  });
  const retry = useMutation({ mutationFn: (id?: string) => api.retryEpisode(id), onSuccess: refresh });

  const pass = status.data?.pass;
  const last = pass?.lastRun;
  return (
    <Card
      title="Nightly pass"
      description={pass ? (pass.enabled ? `Runs at ${pass.at} (${pass.timeZone}). ${status.data?.waiting ?? 0} conversation(s) waiting.` : "Off. Turn it on in Settings.") : undefined}
      actions={
        editable && pass?.enabled ? (
          <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={run.isPending || pass.running} onClick={() => run.mutate()}>
            <Play size={14} /> {run.isPending || pass.running ? "Running…" : "Run now"}
          </button>
        ) : null
      }
    >
      <div className="space-y-2 text-sm">
        <p className="text-base-content/70">
          {last
            ? `Last run ${new Date(last.finishedAt).toLocaleString()}: ${last.filed} filed, ${last.applied} fact(s) kept, ${last.proposed} proposed${last.tidied ? `, ${last.tidied} profile(s) tidied` : ""}, ${last.compacted} archived${last.restored ? `, ${last.restored} transcript(s) restored` : ""}${last.tags ? `, ${last.tags.created} new tag(s)` : ""}${last.failed ? `, ${last.failed} failed` : ""}${last.spent ? `, ${last.spent.tokens.toLocaleString()} tokens${last.spent.estimated ? " (estimated)" : ""}` /* plain-words-ok: tokens, the unit a model's use is billed in */ : ""}.${last.stopped ? ` Stopped: ${last.stopped}` : ""}`
            : "No run yet."}
        </p>
        {pass?.enabled && status.data?.backlog ? <BacklogNote backlog={status.data.backlog} /> : null}
        {last?.tags && last.filed >= 3 && last.tags.created * 3 > last.filed ? (
          <p className="text-warning text-xs font-medium">Many new tags for the conversations filed: a changed model or prompt. The tags card above can tidy them.</p>
        ) : null}
        {(last?.problems ?? []).length > 0 ? (
          <div className="space-y-1">
            <p className="text-warning text-xs font-medium">Passed over, and the rest done:</p>
            <ul className="space-y-1">
              {last!.problems!.map((row) => (
                <li key={row.what} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{row.what}</span>
                  <span className="text-base-content/65 min-w-0 flex-1 truncate">{row.problem}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {(failed.data?.failed ?? []).length > 0 ? (
          <div className="space-y-1">
            <p className="text-warning text-xs font-medium">Could not be filed after every try. The transcript is kept until you retry or delete it.</p>
            <ul className="space-y-1">
              {failed.data!.failed.map((row) => (
                <li key={row.episodeId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{row.episodeId}</span>
                  <span className="text-base-content/65 min-w-0 flex-1 truncate">{row.lastError}</span>
                  {editable ? (
                    <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={() => retry.mutate(row.episodeId)}>
                      <RotateCcw size={12} /> Retry
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
