/**
 * Helpers & jobs (0.8.12): the work an agent left running in the background — helpers it handed a piece to, commands it
 * did not wait for, agents it asked that took longer than 45 seconds — each opening to what it did, as a mission does.
 * Before this a helper's steps were only `nouride jobs log` on the box; a person looks for them here.
 *
 * Laid out as Missions is: a tab per way it ended with its count, a search and an agent filter over the list, and the
 * list scrolling inside its card. Every job `[retention] job_log_days` has left — no count of its own. Asked again every few seconds while
 * anything runs, and only as a slow net once nothing does; a hidden tab asks for nothing.
 */

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/commons/lib/api";
import type { BackgroundJob } from "@nouride/wire";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { agentOptions } from "@/commons/lib/agents";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { RetentionControl } from "@/commons/components/ui/RetentionControl";
import { useMotionList } from "@/commons/hooks/use-motion-list";
import { JobRow } from "./components/JobRow";
import { anyRunning, kindOf, searchedIn, tabOf, type JobKindFilter, type JobTab } from "./lib/job";
import { ListLoading } from "@/commons/components/ui/Spinner";

/**
 * A tab's jobs, from what the daemon sent rather than what the filters left: one that changes state leaves the tab or
 * enters it, and one the kind or the search hides only is not drawn (`shown`) — choosing a filter moves nothing. Kept
 * drawn while the tab is empty, showing `empty` once nothing is left to draw, so it sees the first job arrive.
 */
function JobList({ jobs, shown, empty }: { jobs: BackgroundJob[]; shown: (job: BackgroundJob) => boolean; empty: ReactNode }) {
  const rows = useMotionList(jobs, (job) => job.id, { shown });
  if (rows.length === 0) return empty;
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
  const matched = new Set(found);

  const kindFilter = (
    <SearchSelect small label="Kind" options={KINDS.map((entry) => ({ value: entry.id, label: entry.label }))} value={kind} onChange={setKind} width={176} />
  );

  // The address's `?agent=`, as Missions does — the daemon then sends that agent's only.
  const agentFilter =
    agents.length > 1 || agent ? (
      <SearchSelect
        small
        label="Agent"
        options={agentOptions(agents.map((entry) => entry.id), orchestrator, agent)}
        value={agent ?? ""}
        onChange={(next) => void navigate({ to: "/jobs", search: next ? { agent: next } : {} })}
        width={208}
      />
    ) : null;

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        title="Helpers"
        description="Work an agent left running in the background: helpers it handed a piece to, commands it did not wait for, agents it asked. Each opens to what it did."
      />
      {/* The window that sweeps these rows, as Logs' jobs panel shows it, here too (0.8.12). */}
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
        <JobList
          jobs={(list.data?.jobs ?? []).filter((job) => tab === "all" || tabOf(job) === tab)}
          shown={(job) => matched.has(job)}
          empty={
            counts[tab] === 0 ? (
              <EmptyState pose="sleeping" title={agent && tab === "all" ? `${agent} has nothing in the background yet` : current.none} />
            ) : (
              <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
            )
          }
        />
      </ScrollCard>
    </div>
  );
}
