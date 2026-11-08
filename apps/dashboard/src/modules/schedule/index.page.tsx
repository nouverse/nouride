/**
 * What is scheduled, what it did, and the two buttons that matter.
 * Remade with Apple HIG: segmented filter control, translucent cards,
 * clear cron parameter badges, and refined inline editor.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Clock, Pause, Pencil, Play, Plus, Target, Terminal, Trash2, X, Zap } from "lucide-react";
import { api, type JobSummary } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { runOutcomeToast } from "@/commons/lib/run-outcome";
import { useToast } from "@/commons/components/ui/toast";
import { JobForm } from "./components/JobForm";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { Allowed } from "@/commons/components/jobs/Allowances";
import { inZone, Runs } from "./components/Runs";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { ProposalBar } from "@/commons/components/jobs/ProposalBar";
import { FILL_PAGE, ScrollArea } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { useConfirm } from "@/commons/components/ui/confirm";
import { jobCardId } from "./search";

type Filter = "all" | "active" | "paused" | "failing";

/** Why a row's history badge is the colour it is. Hover text, in one place. */
const SESSION_HINT: Record<JobSummary["session"], string> = {
  fresh: "no history: each run starts clean",
  isolated: "its own private history, kept between runs",
  chat: "reads and appends to the target conversation: the job sees what people said there, and they see its output",
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "failing", label: "Failing" },
];

function payloadLine(job: JobSummary): string {
  if (job.payload.kind === "systemEvent") return String(job.payload.text ?? "");
  if (job.payload.kind === "agentTurn") return String(job.payload.message ?? "");
  if (job.payload.kind === "mission") return `Mission: ${String(job.payload.goal ?? "")}`;
  const argv = Array.isArray(job.payload.argv) ? job.payload.argv.join(" ") : "";
  return `${argv}${job.payload.then === "agentTurn" ? " → agent reads output" : ""}`;
}

const PAYLOAD_ICON = {
  systemEvent: Clock,
  agentTurn: Zap,
  command: Terminal,
  mission: Target,
} as const;

/** `job`: one job a link names (`?job=`, 0.8.11) — its card scrolled to, marked, its runs open. */
export default function SchedulePage({ job: linked }: { job?: string }) {
  const me = useMe();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const { labelOf } = useKnownChats();

  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gatewayList = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  /**
   * Recent conversations, purely so the chat id can be picked rather than pasted.
   *
   * A Discord channel id is eighteen digits and a WhatsApp group id is worse; typing one from memory
   * is not something anybody does correctly. One page is enough — this is a convenience, and the box
   * still accepts anything typed into it.
   */
  // `"chats"` rather than an empty string: the chat page holds an *infinite* query over the same
  // endpoint, and two query types sharing one key is how one of them reads the other's payload. See
  // the note on that query.
  const chatList = useQuery({
    queryKey: ["sessions", "chats"],
    queryFn: () => api.sessions({ limit: 50 }),
  });

  const jobs = useQuery({
    queryKey: ["cron", "all"],
    queryFn: () => api.cron(true),
    refetchInterval: 10_000,
  });

  // The job a link names, once the list holds it: its runs open, its card brought into view. Once per link, so closing
  // its runs is not undone by the next refetch.
  const listed = jobs.data?.jobs;
  const marked = linked && listed?.some((one) => one.id === linked) ? linked : null;
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!marked || focused.current === marked) return;
    focused.current = marked;
    setOpen(marked);
    requestAnimationFrame(() => document.getElementById(jobCardId(marked))?.scrollIntoView?.({ block: "center" }));
  }, [marked]);

  const writable = canWrite(me.data ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["cron"] });

  const toast = useToast();
  const failed = (what: string) => (error: Error) => toast.error(what, error);

  // Each says what went wrong. Pausing, resuming and deleting failed in silence: the row just stayed as it was.
  const act = useMutation({
    mutationFn: ({ job, action }: { job: JobSummary; action: "enable" | "disable" }) =>
      api.cronAction(job.id, action),
    onError: (error, { job, action }) => failed(`Could not ${action === "enable" ? "resume" : "pause"} ${job.name}`)(error),
    onSettled: refresh,
  });
  /**
   * Run answers within ten seconds (`api.cronRun`) — with the outcome, a refusal, or that it is still going, in which
   * case its runs open and follow it to the end. A refusal ("that job is already running") came back as a 200 and was
   * treated as success; nothing at all was said about any of the others.
   */
  const runNow = useMutation({
    mutationFn: (job: JobSummary) => api.cronRun(job.id),
    onSuccess: ({ outcome }, job) => {
      toast.show(runOutcomeToast(job.name, outcome));
      if (outcome.status === "running") setOpen(job.id);
    },
    onError: (error, job) => failed(`${job.name} did not start`)(error),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (job: JobSummary) => api.cronDelete(job.id),
    onError: (error, job) => failed(`Could not delete ${job.name}`)(error),
    onSettled: refresh,
  });
  const { ask, dialog } = useConfirm();

  if (jobs.isLoading) {
    return (
      <div className="flex justify-center p-16">
        <span className="loading loading-spinner loading-lg text-primary opacity-60" />
      </div>
    );
  }

  // "Not enabled" only when the daemon says so (501). A boot's 503 or a timeout said it too, which it was not.
  if (jobs.error && !jobs.data) {
    if (!(jobs.error instanceof ApiError && jobs.error.status === 501)) return <ErrorNote error={jobs.error} />;
    return (
      <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-2xl p-4">
        <AlertTriangle size={18} />
        <span>Scheduled work is not turned on for this server.</span>
      </div>
    );
  }

  const timezone = jobs.data?.timezone ?? "UTC";
  const list = jobs.data?.jobs ?? [];
  const agents = status.data?.agents ?? [];
  const gateways = gatewayList.data?.gateways ?? [];
  const chats = chatList.data?.sessions ?? [];

  const counts = {
    all: list.length,
    active: list.filter((job) => job.enabled).length,
    paused: list.filter((job) => !job.enabled).length,
    failing: list.filter((job) => job.failStreak > 0).length,
  };

  const shown = list.filter((job) =>
    filter === "active"
      ? job.enabled
      : filter === "paused"
        ? !job.enabled
        : filter === "failing"
          ? job.failStreak > 0
          : true,
  );

  return (
    <div className={FILL_PAGE}>
      {dialog}
      <PageHeader
        title="Schedule"
        description={`Work that runs on a schedule, again and again or once. Times are in the server's time zone (${timezone}) unless a job names its own.`}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
            disabled={!writable}
            onClick={() => {
              setEditing(null);
              setCreating((open) => !open);
            }}
          >
            {creating ? <X size={16} /> : <Plus size={16} />}
            {creating ? "Close" : "New job"}
          </button>
        }
      />

      {creating && (
        <Card title="Schedule something" className="border-primary/30 shadow-lg">
          <JobForm
            timezone={timezone}
            agents={agents}
            gateways={gateways}
            chats={chats}
            onDone={() => {
              setCreating(false);
              refresh();
            }}
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}

      <SegmentedTabs
        tabs={FILTERS.map((entry) => ({
          value: entry.id,
          label: entry.label,
          after: <Count n={counts[entry.id]} highlight={entry.id === "failing" && counts.failing > 0} />,
        }))}
        value={filter}
        onChange={setFilter}
      />

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock}
            title="Nothing is scheduled"
            description={'Press "New job", or just ask an agent: "remind me to check the deploy in two hours".'}
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={Clock} title={`No ${filter} jobs`} />
        </Card>
      ) : null}

      {/* Its own scroll: a box with thirty jobs should not push the filters and the form off the top. Keyed by the
          filter, to fade in anew when it changes (`FILL_PAGE`). */}
      <ScrollArea key={filter} fill className="space-y-3 pr-1">
        {shown.map((job) => {
          const Icon = PAYLOAD_ICON[job.payload.kind] ?? Clock;
          const failing = job.failStreak > 0;
          return (
            <div
              key={job.id}
              id={jobCardId(job.id)}
              aria-current={marked === job.id ? "true" : undefined}
              className={`rounded-2xl border bg-base-100/80 backdrop-blur-xl shadow-xs transition-all duration-200 ${
                marked === job.id ? "border-primary/60 ring-2 ring-primary/30" : "border-base-content/[0.08] hover:border-base-content/15"
              }`}
            >
              <div className="p-4 sm:p-5 space-y-3">
                {/* The name takes 16rem before the actions sit beside it: on a phone they go under it, where beside it they
                    left the name a word a line. */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-[1_1_16rem]">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-base-200 text-base-content/70 shrink-0">
                        <Icon size={15} />
                      </div>
                      <span className="font-bold text-sm tracking-tight text-base-content">{job.name}</span>
                      {job.proposal ? null : !job.enabled ? (
                        <span className="badge badge-sm badge-ghost text-base-content/65 font-medium font-mono">
                          {job.disabledReason ?? "paused"}
                        </span>
                      ) : (
                        <span className="badge badge-sm badge-success font-medium font-mono">Active</span>
                      )}
                      {/* Said on every row, because it is the field that decides what a run costs. */}
                      <span
                        className={`badge badge-sm font-mono text-[11px] ${
                          job.session === "chat" ? "badge-warning badge-outline" : "badge-outline"
                        }`}
                        title={SESSION_HINT[job.session]}
                      >
                        {job.session}
                      </span>
                    </div>
                    <p className="text-base-content/75 text-sm mt-1">{job.describes}</p>
                    <p className="text-base-content/65 truncate font-mono text-xs mt-1 bg-base-200/50 px-2 py-1 rounded-md max-w-xl">
                      {payloadLine(job)}
                    </p>
                  </div>

                  {job.proposal ? <ProposalBar job={job} canAnswer={writable} onAnswered={refresh} /> : <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium hover:bg-base-200"
                      disabled={!writable}
                      onClick={() => setEditing(editing === job.id ? null : job.id)}
                      title="Edit this job"
                    >
                      {editing === job.id ? <X size={13} /> : <Pencil size={13} />}
                      <span>{editing === job.id ? "Close" : "Edit"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium text-primary hover:bg-primary/10"
                      // This row's run only: one in flight used to grey out every Run on the page.
                      disabled={!writable || (runNow.isPending && runNow.variables?.id === job.id)}
                      onClick={() => runNow.mutate(job)}
                      title="Run immediately"
                    >
                      {runNow.isPending && runNow.variables?.id === job.id ? (
                        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                      ) : (
                        <Play size={13} />
                      )}
                      <span>Run</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium hover:bg-base-200"
                      disabled={!writable}
                      onClick={() =>
                        act.mutate({ job, action: job.enabled ? "disable" : "enable" })
                      }
                    >
                      {job.enabled ? <Pause size={13} /> : <Play size={13} />}
                      <span>{job.enabled ? "Pause" : "Resume"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
                      disabled={!writable}
                      onClick={async () => {
                        const yes = await ask({
                          title: `Delete "${job.name}"?`,
                          body: "It stops running, and its run history goes with it. Pause it instead to keep both.",
                          confirmLabel: "Delete",
                        });
                        if (yes) remove.mutate(job);
                      }}
                      title="Delete job"
                      aria-label={`Delete ${job.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>}
                </div>

                <div className="text-base-content/65 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs pt-1 border-t border-base-content/[0.05]">
                  <span>
                    Next: <strong className="font-mono text-base-content/80 font-normal">{inZone(job.nextRunAt, timezone)}</strong>
                  </span>
                  <span>
                    Last: <strong className="font-mono text-base-content/80 font-normal">{inZone(job.lastRunAt, timezone)}</strong>
                  </span>
                  <span className="badge badge-xs badge-ghost font-mono">{job.agentId}</span>
                  <span className="font-mono text-[11px] text-base-content/65" title={job.target.chatId}>
                    {job.target.gatewayId} · {labelOf(job.target.gatewayId, job.target.chatId) ?? job.target.chatId}
                  </span>
                  <span>
                    {job.runCount} {job.runCount === 1 ? "run" : "runs"}
                    {job.failCount > 0 && <span className="text-error font-medium"> · {job.failCount} failed</span>}
                  </span>
                  {failing && (
                    <span className="text-warning font-semibold">
                      ⚠️ {job.failStreak} consecutive failures
                    </span>
                  )}
                </div>

                {editing === job.id && (
                  <div className="border-t border-base-content/10 mt-3 pt-4">
                    <JobForm
                      job={job}
                      timezone={timezone}
                      agents={agents}
                      gateways={gateways}
                      chats={chats}
                      onDone={() => {
                        setEditing(null);
                        refresh();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}

                <div className="pt-1">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs gap-1 text-base-content/65 hover:text-base-content"
                    onClick={() => setOpen(open === job.id ? null : job.id)}
                  >
                    {open === job.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    <span>{open === job.id ? "Hide execution runs" : "Show execution runs"}</span>
                  </button>
                </div>

                <Allowed job={job} canEdit={writable} />
                {open === job.id && <Runs id={job.id} timezone={timezone} canEdit={writable} />}
              </div>
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
