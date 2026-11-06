/**
 * One background job (0.8.12): what it was asked to do, what it did step by step, and what it handed back — the page
 * that `nouride jobs log` and `nouride turns show` were, on the box only, until the owner asked for it here.
 *
 * Three sources. The job and the end of its log (`/jobs/:id/log`), asked again every few seconds while it runs. For a
 * helper or an asked agent, its own turn: the job keeps the turn that started it, and that turn's record lists the
 * turns it handed off, each with its job's id — so the page reads that record and opens the one that is this job's.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FolderOpen, ListChecks, Square, TriangleAlert } from "lucide-react";
import { api, type BackgroundJob, type JobReport } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { Markdown } from "@/commons/components/ui/Markdown";
import { TurnRecord } from "@/commons/components/turns/TurnRecord";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ago } from "@/commons/lib/format";
import { formatDuration } from "@/commons/lib/steps";
import { canWrite, useMe } from "@/commons/lib/session";
import { KindBadge, StatusBadge } from "./components/JobRow";
import { jobTitle, kindOf, ownTurnOf, ranFor } from "./lib/job";

const RUNNING_MS = 3_000;

const REPORTED: Record<JobReport["status"], { said: string; tone: string }> = {
  success: { said: "Finished", tone: "text-success" },
  incomplete: { said: "Not finished", tone: "text-warning" },
  requires_human: { said: "Stopped at an approval nobody gave", tone: "text-warning" },
  failed: { said: "Failed", tone: "text-error" },
};

function Label({ children }: { children: string }) {
  return <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">{children}</p>;
}

/** What a helper was handed, or what an agent was asked: the words the work started from. */
function Asked({ job }: { job: BackgroundJob }) {
  const parts = job.brief
    ? ([
        ["Goal", job.brief.goal],
        ["Context", job.brief.context],
        ["Constraints", job.brief.constraints],
        ["Deliverable", job.brief.deliverable],
      ] as const)
    : job.ask
      ? ([["Asked " + job.ask.agent, job.ask.task]] as const)
      : ([["Command", job.command]] as const);
  return (
    <div className="space-y-3 text-sm">
      {parts.map(([label, text]) =>
        text ? (
          <div key={label} className="space-y-1">
            <Label>{label}</Label>
            <p className="whitespace-pre-wrap leading-relaxed text-base-content/85 [overflow-wrap:anywhere]">{text}</p>
          </div>
        ) : null,
      )}
      <p className="flex items-start gap-1.5 font-mono text-xs text-base-content/70 break-all">
        <FolderOpen size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {job.cwd}
      </p>
    </div>
  );
}

function Report({ report }: { report: JobReport }) {
  const { said, tone } = REPORTED[report.status];
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className={`font-semibold ${tone}`}>{said}</span>
        {report.reason ? <span className="text-base-content/75">: {report.reason}</span> : null}
        <span className="ml-2 font-mono text-[11px] text-base-content/65">
          {report.metrics.toolCalls} tool calls · {formatDuration(report.metrics.ms)}
        </span>
      </p>
      {report.summary && (
        <div className="text-sm [overflow-wrap:anywhere]">
          <Markdown source={report.summary} />
        </div>
      )}
      {report.files.length > 0 && (
        <div className="space-y-1">
          <Label>Files it wrote</Label>
          <ul className="space-y-0.5 font-mono text-xs text-base-content/80 break-all">
            {report.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A helper's or an asked agent's own turn: each model call it made and what each request carried. */
function OwnTurn({ job }: { job: BackgroundJob }) {
  const started = useQuery({
    queryKey: ["turn-record", job.turnId ?? ""],
    queryFn: () => api.turnRecord(job.turnId!),
    enabled: Boolean(job.turnId),
    retry: false,
    refetchInterval: job.status === "running" ? RUNNING_MS * 5 : false,
  });
  const own = ownTurnOf(job.id, started.data?.delegated);
  if (!own) return null;
  return (
    <Card title="Its turn" description={`${own.id}: what each of its requests carried. Its model calls are counted with the turn that started it.`}>
      <TurnRecord turnId={own.id} />
    </Card>
  );
}

export default function JobPage({ jobId }: { jobId: string }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const found = useQuery({
    queryKey: ["jobs", "detail", jobId],
    queryFn: () => api.jobLog(jobId),
    refetchInterval: (query) => (query.state.data?.job.status === "running" ? RUNNING_MS : false),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const stop = useMutation({
    mutationFn: () => api.stopJob(jobId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  if (found.isLoading) {
    return (
      <div className="flex justify-center p-16">
        <span className="loading loading-spinner loading-lg text-primary opacity-60" />
      </div>
    );
  }
  if (!found.data) {
    if (found.error instanceof ApiError && found.error.status === 404) {
      return (
        <Card>
          <EmptyState
            icon={ListChecks}
            title="No such job"
            description={`There is no job called ${jobId} here.`}
            action={
              <Link to="/jobs" className="btn btn-sm btn-ghost">
                All jobs
              </Link>
            }
          />
        </Card>
      );
    }
    return <ErrorNote error={found.error} />;
  }

  const { job, log } = found.data;
  const running = job.status === "running";
  const turnWork = kindOf(job) !== "command";

  return (
    <div className="space-y-5">
      <Link to="/jobs" className="btn btn-ghost btn-xs -ml-2 gap-1.5 rounded-lg text-base-content/70">
        <ArrowLeft size={13} aria-hidden="true" /> Background Helpers
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <StatusBadge job={job} />
            <KindBadge job={job} />
          </span>
          <span className="font-mono text-[11px] text-base-content/65 break-all">
            {job.agentId} · {job.id} · started {ago(job.startedAt)} · {running ? "running " : "ran "}
            {formatDuration(ranFor(job))}
            {job.exitCode !== null && !running ? ` · exit ${job.exitCode}` : ""} · reports to {job.gatewayId}
          </span>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <h1 className="min-w-0 text-lg font-semibold leading-snug tracking-tight text-base-content line-clamp-3 [overflow-wrap:anywhere] sm:text-xl">{jobTitle(job)}</h1>
          {running && (
            <button
              type="button"
              className="btn btn-sm btn-outline btn-error shrink-0 gap-1.5 rounded-xl"
              disabled={!canWrite(me.data ?? null) || stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square size={13} aria-hidden="true" /> Stop it
            </button>
          )}
        </div>
        {stop.error ? <ErrorNote error={stop.error} /> : null}
      </header>

      {running && job.processAlive === false && (
        <div role="status" className="alert alert-soft alert-warning rounded-2xl text-sm">
          <TriangleAlert size={16} aria-hidden="true" /> It says running, but nothing is running it: Nouride stopped while it worked.
        </div>
      )}

      {job.report && (
        <Card title="Result" description="What it handed back to the agent that started it.">
          <Report report={job.report} />
        </Card>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card
          title={turnWork ? "Steps" : "Output"}
          description={`${turnWork ? "What it did, step by step" : "What it printed"}${running ? ", as it happens" : ""}: the end of ${(job.logBytes / 1024).toFixed(1)} KB.`}
          className="min-w-0"
        >
          {log ? (
            <pre className="max-h-[36rem] overflow-auto rounded-xl bg-base-200/70 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{log}</pre>
          ) : (
            <p className="text-sm text-base-content/65">Nothing written yet.</p>
          )}
        </Card>

        <aside className="min-w-0 space-y-5">
          <Card title={job.brief ? "Brief" : job.ask ? "Asked" : "Command"}>
            <Asked job={job} />
          </Card>
          {turnWork && <OwnTurn job={job} />}
        </aside>
      </div>
    </div>
  );
}
