/**
 * Missions (0.8.0): long work an agent finishes alone, listed the way a person acts on it — what needs you first, then
 * what is working, then what has finished. A list, not a board: a mission moves on its own, and there is nothing to drag.
 * Laid out as the other list pages are: a tab per group with its count, a search and an agent filter over the list, and
 * the list scrolling inside its card, so the tabs stay in reach however many have finished. What finished is the last 3,
 * 7, 14 or 30 days of it, 3 unless chosen — never all (0.8.8); what is still open is listed however old.
 *
 * Asked again every few seconds while anything can still change, and only as a slow net once nothing can; a hidden tab
 * asks for nothing, which is the query client's own rule for an interval.
 */

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, SlidersHorizontal, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionView } from "@nouride/wire";
import { ApiError } from "@/commons/lib/api.client";
import { canWrite, useMe } from "@/commons/lib/session";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { CardGrid } from "@/commons/components/ui/CardGrid";
import { useMotionList, type Moving } from "@/commons/hooks/use-motion-list";
import { MissionCard } from "./components/MissionCard";
import { MissionSettingsCard } from "./components/MissionSettingsCard";
import { NewMissionForm } from "./components/NewMissionForm";
import { anyOpen, grouped, searchedIn, tabOf, type MissionTab } from "./lib/mission";
import { ListLoading } from "@/commons/components/ui/Spinner";

/** While something is working or waiting on a person; a finished list changes only when somebody starts one. */
const OPEN_MS = 5_000;
const SETTLED_MS = 30_000;

/**
 * How far back the finished ones go — 3 days unless chosen, the owner's word ("defaultnya 3 hari saja"), a month at most,
 * the daemon's own bound (`GET /missions?days=`).
 */
const SPANS = [3, 7, 14, 30] as const;
type Span = (typeof SPANS)[number];

const TABS: { id: MissionTab; label: string; title: (n: number) => string; none: (days: Span) => string }[] = [
  { id: "all", label: "All", title: (n) => `${n} mission${n === 1 ? "" : "s"}`, none: () => "No missions yet" },
  { id: "needs_you", label: "Needs you", title: (n) => `${n} need${n === 1 ? "s" : ""} you`, none: () => "Nothing needs you" },
  { id: "working", label: "Working", title: (n) => `${n} working`, none: () => "Nothing is working" },
  { id: "done", label: "Done", title: (n) => `${n} done`, none: (days) => `Nothing done in the last ${days} days` },
  { id: "failed", label: "Failed", title: (n) => `${n} failed`, none: (days) => `Nothing failed in the last ${days} days` },
  { id: "stopped", label: "Stopped", title: (n) => `${n} stopped`, none: (days) => `Nothing stopped in the last ${days} days` },
];

/**
 * The missions a tab shows, from what the daemon sent rather than what the search left: a mission that changes state
 * leaves its group and enters the next, and one the search hides only is not drawn (`shown`) — typing moves nothing.
 * Kept drawn while the tab is empty, showing `empty` once nothing is left to draw, so it sees the first mission arrive.
 */
function MissionList({ missions, tab, shown, empty }: { missions: MissionView[]; tab: MissionTab; shown: (mission: MissionView) => boolean; empty: ReactNode }) {
  const groups = grouped(missions);
  const key = (mission: MissionView) => mission.id;
  const needsYou = useMotionList(groups.needsYou, key, { shown });
  const working = useMotionList(groups.working, key, { shown });
  const finished = useMotionList(groups.finished, key, { shown });
  const inTab = useMotionList(missions.filter((mission) => tabOf(mission) === tab), key, { shown });
  if (tab !== "all") return inTab.length === 0 ? empty : <Cards cards={inTab} />;
  if (needsYou.length + working.length + finished.length === 0) return empty;
  return (
    <div className="space-y-7">
      <Group title="Needs you" cards={needsYou} count={groups.needsYou.filter(shown).length} />
      <Group title="Working" cards={working} count={groups.working.filter(shown).length} />
      <Group title="Finished" cards={finished} count={groups.finished.filter(shown).length} />
    </div>
  );
}

function Group({ title, cards, count }: { title: string; cards: Moving<MissionView>[]; count: number }) {
  if (cards.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2.5">
      <h3 className="px-1 font-mono text-[11px] font-bold uppercase tracking-wider text-base-content/65">
        {title} <span className="font-normal">· {count}</span>
      </h3>
      <Cards cards={cards} />
    </section>
  );
}

/** The missions as cards, in the Knowledge tab's grid. */
function Cards({ cards }: { cards: Moving<MissionView>[] }) {
  return (
    <CardGrid>
      {cards.map(({ key, item, motion }) => (
        <MissionCard key={key} mission={item} motion={motion} />
      ))}
    </CardGrid>
  );
}

export default function MissionsPage({ agent }: { agent?: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [tab, setTab] = useState<MissionTab>("all");
  const [filter, setFilter] = useState("");
  const [days, setDays] = useState<Span>(3);
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const list = useQuery({
    queryKey: ["missions", "list", agent ?? "", days],
    queryFn: () => api.missions(agent, days),
    refetchInterval: (query) => (anyOpen(query.state.data?.missions ?? []) ? OPEN_MS : SETTLED_MS),
    retry: false,
  });
  const writable = canWrite(me.data ?? null);
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (entry) => entry.id);
  const missions = list.data?.missions ?? [];
  const found = useTextFilter(missions, filter, searchedIn);

  if (list.isLoading) {
    return <ListLoading shape="cards" />;
  }

  // "Not run here" only when the daemon says so (501) — a boot's 503 or a timeout is an error, said as one.
  if (list.error && !list.data) {
    if (!(list.error instanceof ApiError && list.error.status === 501)) return <ErrorNote error={list.error} />;
    return (
      <div className="alert alert-warning rounded-2xl border border-warning/30 bg-warning/10 p-4 text-warning">
        <AlertTriangle size={18} />
        <span>Missions are not turned on for this server.</span>
      </div>
    );
  }

  const counts: Record<MissionTab, number> = { all: missions.length, needs_you: 0, working: 0, done: 0, failed: 0, stopped: 0 };
  for (const mission of missions) counts[tabOf(mission)] += 1;
  const current = TABS.find((entry) => entry.id === tab)!;
  const matched = new Set(found);
  const shown = (mission: MissionView) => matched.has(mission);

  const spanFilter = (
    <select className="select select-sm w-36 rounded-xl" aria-label="Finished in" value={days} onChange={(event) => setDays(Number(event.target.value) as Span)}>
      {SPANS.map((span) => (
        <option key={span} value={span}>
          Last {span} days
        </option>
      ))}
    </select>
  );

  // The agent filter is the address's `?agent=`, as an agent's page links here — so the daemon sends that agent's only.
  const agentFilter =
    agents.length > 1 || agent ? (
      <select
        className="select select-sm w-40 rounded-xl"
        aria-label="Agent"
        value={agent ?? ""}
        onChange={(event) => void navigate({ to: "/missions", search: event.target.value ? { agent: event.target.value } : {} })}
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
        title="Missions"
        description="Long work an agent finishes alone. It reports to the chat it began in, and stops to ask when it needs you."
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm gap-2 rounded-xl"
              aria-expanded={limitsOpen}
              onClick={() => setLimitsOpen((open) => !open)}
            >
              {limitsOpen ? <X size={15} aria-hidden="true" /> : <SlidersHorizontal size={15} aria-hidden="true" />}
              {limitsOpen ? "Close limits" : "Limits"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm gap-2 rounded-xl shadow-xs transition-all active:scale-95"
              disabled={!writable}
              onClick={() => setCreating((open) => !open)}
            >
              {creating ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
              {creating ? "Close" : "New mission"}
            </button>
          </>
        }
      />

      {creating && (
        <Card title="Start a mission" className="border-primary/30 shadow-lg">
          <NewMissionForm
            agents={status.data?.agents ?? []}
            onCancel={() => setCreating(false)}
            onStarted={(mission) => {
              setCreating(false);
              void queryClient.invalidateQueries({ queryKey: ["missions"] });
              void navigate({ to: "/missions/$missionId", params: { missionId: mission.id } });
            }}
          />
        </Card>
      )}

      {limitsOpen && <MissionSettingsCard />}

      <SegmentedTabs
        tabs={TABS.map((entry) => ({
          value: entry.id,
          label: entry.label,
          // The one count coloured: it is the one that means somebody has to do something.
          after: <Count n={counts[entry.id]} highlight={entry.id === "needs_you" && counts.needs_you > 0} />,
        }))}
        value={tab}
        onChange={setTab}
      />

      {/* Keyed by the tab, so the list it filters is drawn anew and fades in (`FILL_PAGE`). */}
      <ScrollCard
        key={tab}
        fill
        title={current.title(counts[tab])}
        {...(missions.length > 0 ? { search: { value: filter, onChange: setFilter, placeholder: "Search missions" } } : {})}
        actions={
          <>
            {spanFilter}
            {agentFilter}
          </>
        }
      >
        <MissionList
          missions={missions}
          tab={tab}
          shown={shown}
          empty={
            missions.length === 0 && tab === "all" ? (
              <EmptyState
                pose="sleeping"
                title={agent ? `${agent} has no missions in the last ${days} days` : `No missions in the last ${days} days`}
                description="Start one here, or send /mission and a goal in a chat. An agent also starts one when a piece of work needs hours rather than a reply."
              />
            ) : counts[tab] === 0 ? (
              <EmptyState pose="sleeping" title={current.none(days)} />
            ) : (
              <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
            )
          }
        />
      </ScrollCard>
    </div>
  );
}
