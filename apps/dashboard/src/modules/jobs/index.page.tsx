/**
 * Helpers & jobs (0.8.12): the work an agent left running in the background — helpers it handed a piece to, commands it
 * did not wait for, agents it asked that took longer than a minute — each opening to what it did, as a mission does.
 * Before this a helper's steps were only `nouride jobs log` on the box; the owner asked for it here.
 *
 * Laid out as Missions is: a tab per way it ended with its count, a search and an agent filter over the list, and the
 * list scrolling inside its card. Every job `[retention] job_log_days` has left — no count of its own. Asked again every few seconds while
 * anything runs, and only as a slow net once nothing does; a hidden tab asks for nothing.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { api, type BackgroundJob } from "@/commons/lib/api";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/ui/AgentName";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { RetentionControl } from "@/commons/components/ui/RetentionControl";
import { useMotionList } from "@/commons/hooks/use-motion-list";
import { JobRow } from "./components/JobRow";
import { anyRunning, kindOf, searchedIn, tabOf, type JobKindFilter, type JobTab } from "./lib/job";
import { ListLoading } from "@/commons/components/ui/Spinner";

/**
 * A tab's jobs, from what the daemon sent rather than what the filters left: one that changes state leaves the tab or
 * enters it, and one the kind or the search hides only is not drawn (`shown`) — choosing a filter moves nothing.
 */
function JobList({ jobs, shown }: { jobs: BackgroundJob[]; shown: (job: BackgroundJob) => boolean }) {
  const rows = useMotionList(jobs, (job) => job.id, { shown });
  return (
    <div className="space-y-2.5">
      {rows.map(({ key, item, motion }) => (
        <JobRow key={key} job={item} motion={motion} />
      ))}
    </div>
  );
}

const RUNNING_MS = 5_000;
const SETTLED_MS = 30_000;

const TABS: { id: JobTab; label: string; title: (n: number) => string; none: string }[] = [
  { id: "all", label: "All", title: (n) => `${n} job${n === 1 ? "" : "s"}`, none: "Nothing has run in the background yet" },
  { id: "running", label: "Running", title: (n) => `${n} running`, none: "Nothing is running" },
  { id: "done", label: "Done", title: (n) => `${n} done`, none: "Nothing done yet" },
  { id: "failed", label: "Failed", title: (n) => `${n} failed`, none: "Nothing failed" },
  { id: "stopped", label: "Stopped", title: (n) => `${n} stopped`, none: "Nothing stopped" },
];

const KINDS: { id: JobKindFilter; label: string }[] = [
  { id: "all", label: "Every kind" },
  { id: "helper", label: "Helpers" },
  { id: "command", label: "Commands" },
  { id: "ask", label: "Asked agents" },
];

export default function JobsPage({ agent }: { agent?: string }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<JobTab>("all");
  const [kind, setKind] = useState<JobKindFilter>("all");
  const [filter, setFilter] = useState("");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const list = useQuery({
    queryKey: ["jobs", "list", agent ?? ""],
    queryFn: () => api.jobs(agent),
    refetchInterval: (query) => (anyRunning(query.state.data?.jobs ?? []) ? RUNNING_MS : SETTLED_MS),
    retry: false,
  });
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (entry) => entry.id);
  const jobs = (list.data?.jobs ?? []).filter((job) => kind === "all" || kindOf(job) === kind);
  const found = useTextFilter(jobs, filter, searchedIn);

  if (list.isLoading) {
    return <ListLoading />;
  }
  if (list.error && !list.data) return <ErrorNote error={list.error} />;

  const counts: Record<JobTab, number> = { all: jobs.length, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const job of jobs) counts[tabOf(job)] += 1;
  const current = TABS.find((entry) => entry.id === tab)!;
  const inTab = tab === "all" ? found : found.filter((job) => tabOf(job) === tab);
  const matched = new Set(found);

  const kindFilter = (
    <select className="select select-sm w-36 rounded-xl" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as JobKindFilter)}>
      {KINDS.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
    </select>
  );

  // The address's `?agent=`, as Missions does — the daemon then sends that agent's only.
  const agentFilter =
    agents.length > 1 || agent ? (
      <select
        className="select select-sm w-40 rounded-xl"
        aria-label="Agent"
        value={agent ?? ""}
        onChange={(event) => void navigate({ to: "/jobs", search: event.target.value ? { agent: event.target.value } : {} })}
      >
        <option value="">Every agent</option>
        {agents.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.id === orchestrator ? `${entry.id} (orchestrator)` : entry.id}
          </option>
        ))}
        {agent && !agents.some((entry) => entry.id === agent) ? <option value={agent}>{agent}</option> : null}
      </select>
    ) : null;

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        title="Background Helpers"
        description="Work an agent left running in the background: helpers it handed a piece to, commands it did not wait for, agents it asked. Each opens to what it did."
      />
      {/* The window that sweeps these rows, as System Logs' jobs panel shows it — the owner asked for it here (0.8.12). */}
      <RetentionControl scope="jobLogs" />

      <SegmentedTabs
        tabs={TABS.map((entry) => ({ value: entry.id, label: entry.label, after: <Count n={counts[entry.id]} highlight={entry.id === "running" && counts.running > 0} /> }))}
        value={tab}
        onChange={setTab}
      />

      {/* Keyed by the tab, so the list it filters is drawn anew and fades in (`FILL_PAGE`). */}
      <ScrollCard
        key={tab}
        fill
        title={current.title(counts[tab])}
        {...(jobs.length > 0 ? { search: { value: filter, onChange: setFilter, placeholder: "Search jobs" } } : {})}
        actions={
          <>
            {kindFilter}
            {agentFilter}
          </>
        }
      >
        {counts[tab] === 0 ? (
          <EmptyState icon={Bot} title={agent && tab === "all" ? `${agent} has nothing in the background yet` : current.none} />
        ) : inTab.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
        ) : (
          <JobList jobs={(list.data?.jobs ?? []).filter((job) => tab === "all" || tabOf(job) === tab)} shown={(job) => matched.has(job)} />
        )}
      </ScrollCard>
    </div>
  );
}
