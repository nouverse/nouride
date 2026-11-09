/** Logs → Helpers: commands an agent started and did not wait for, and whether each is still there. */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, MessagesSquare, Terminal, TriangleAlert } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState } from "@/commons/components/ui/ui";
import { Panel } from "./Panel";
import { ListLoading } from "@/commons/components/ui/Spinner";

export function BackgroundJobs() {
  const jobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: api.backgroundJobs,
    refetchInterval: 5_000,
    retry: false,
  });

  if (jobs.error) {
    return (
      <Card className="shrink-0">
        <EmptyState icon={Terminal} title="Helpers are not turned on here" />
      </Card>
    );
  }

  const list = jobs.data?.jobs ?? [];

  return (
    <Panel
      title="Helpers"
      retention="jobLogs"
      description="Commands started with exec background: true, helpers started with delegate background: true, and helpers waited for or agents asked with ask_agent that were still working after 45 seconds (the turn that launched one is long over while it runs). A row opens its page under Helpers: its output, or a helper's or an asked agent's steps."
    >
      {jobs.isPending ? (
        <ListLoading count={5} />
      ) : list.length === 0 ? (
        <EmptyState icon={Terminal} title="Nothing running or recently finished" />
      ) : (
        <div className="space-y-1.5">
          {list.map((job) => (
            <Link
              key={job.id}
              to="/jobs/$jobId"
              params={{ jobId: job.id }}
              className="block rounded-xl border border-base-content/[0.08] p-2.5 space-y-1 transition-colors hover:border-base-content/20"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`badge badge-sm font-semibold ${
                    job.status === "running"
                      ? "badge-info"
                      : // By how it ended, not by its exit code: a helper has none, and a command's `succeeded` is its 0.
                        job.status === "succeeded"
                        ? "badge-success"
                        : "badge-error"
                  }`}
                >
                  {job.status}
                  {job.exitCode !== null && job.status !== "running" ? ` · exit ${job.exitCode}` : ""}
                </span>
                {/* A row that says `running` with no process behind it is what a daemon that died
                    mid-job leaves. Worth saying out loud rather than leaving as a spinner. */}
                {job.status === "running" && job.processAlive === false && (
                  <span className="badge badge-sm badge-warning gap-1 font-mono">
                    <TriangleAlert size={10} /> no process
                  </span>
                )}
                {job.kind === "helper" && (
                  <span className="badge badge-sm badge-ghost gap-1 font-mono text-[10px]">
                    <Bot size={10} /> helper
                  </span>
                )}
                {job.kind === "ask" && (
                  <span className="badge badge-sm badge-ghost gap-1 font-mono text-[10px]">
                    <MessagesSquare size={10} /> ask
                  </span>
                )}
                <span className="badge badge-sm badge-ghost font-mono text-[10px]">{job.agentId}</span>
                <span className="font-mono text-[10px] text-base-content/65">
                  {new Date(job.startedAt).toLocaleString([], { hour12: false })}
                  {job.endedAt ? ` → ${Math.round((job.endedAt - job.startedAt) / 1000)}s` : ""}
                </span>
                <span className="font-mono text-[10px] text-base-content/65">
                  {(job.logBytes / 1024).toFixed(1)} KB of output
                </span>
              </div>
              <p className="font-mono text-[11px] text-base-content/80 break-all bg-base-200/50 rounded-lg px-2 py-1">
                {job.command}
              </p>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}
