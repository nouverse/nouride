/**
 * Missions (0.8.0): long work an agent finishes alone, listed the way a person acts on it — what needs you first, then
 * what is working, then what has finished. A list, not a board: a mission moves on its own, and there is nothing to drag.
 * Laid out as the other list pages are: a tab per group with its count, a search and an agent filter over the list, and
 * the list scrolling inside its card, so the tabs stay in reach however many have finished. What finished is the last 3,
 * 7, 14 or 30 days of it, 3 unless chosen — never all (0.8.8); what is still open is listed however old.
 *
 * The list is the reader's own: what they started, and what reports to a chat of theirs. An admin picks whose beside
 * the search, as on Chats: everyone's, set apart by person with what is nobody's last, one person's, or nobody's alone.
 * Under an admin's own list a line says how many more there are, so a short list is not read as the rest being gone.
 *
 * Asked again every few seconds while anything can still change, and only as a slow net once nothing can; a hidden tab
 * asks for nothing, which is the query client's own rule for an interval.
 */

import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, SlidersHorizontal, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionView } from "@nouride/wire";
import { ApiError } from "@/commons/lib/api.client";
import { canWrite, useMe } from "@/commons/lib/session";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { Elsewhere, elsewhereWords, ShowEveryone } from "@/commons/components/people/Elsewhere";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { useWhose, type Whose } from "@/commons/hooks/use-whose";
import { MissionFilters, type Span } from "./components/MissionFilters";
import { MissionList, MissionsByPerson } from "./components/MissionList";
import { MissionSettingsCard } from "./components/MissionSettingsCard";
import { NewMissionForm } from "./components/NewMissionForm";
import { anyOpen, searchedIn, tabOf, type MissionTab } from "./lib/mission";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

/** While something is working or waiting on a person; a finished list changes only when somebody starts one. */
const OPEN_MS = 5_000;
const SETTLED_MS = 30_000;

const TABS: { id: MissionTab; label: string; title: (n: number) => string; none: (days: Span) => string }[] = [
  { id: "all", label: "All", title: (n) => `${n} mission${n === 1 ? "" : "s"}`, none: () => "No missions yet" },
  { id: "needs_you", label: "Needs you", title: (n) => `${n} need${n === 1 ? "s" : ""} you`, none: () => "Nothing needs you" },
  { id: "working", label: "Working", title: (n) => `${n} working`, none: () => "Nothing is working" },
  { id: "done", label: "Done", title: (n) => `${n} done`, none: (days) => `Nothing done in the last ${days} days` },
  { id: "failed", label: "Failed", title: (n) => `${n} failed`, none: (days) => `Nothing failed in the last ${days} days` },
  { id: "stopped", label: "Stopped", title: (n) => `${n} stopped`, none: (days) => `Nothing stopped in the last ${days} days` },
];

/**
 * What a list with no missions says. The reader's own: how one is started; with others' left out of it (`elsewhere`),
 * how many, and the press that lists them, so an empty page is not read as everything gone. Where an admin looked at
 * someone else's: whose was looked at, not how to start one.
 */
function noMissions({ whose, days, agent, elsewhere, onEveryone }: { whose: Whose; days: Span; agent: string | undefined; elsewhere: number; onEveryone: () => void }): ReactNode {
  if (elsewhere > 0) {
    const title = agent ? `${agent} has no missions of yours in the last ${days} days` : `No missions of yours in the last ${days} days`;
    return <EmptyState pose="sleeping" title={title} description={elsewhereWords(elsewhere)} action={<ShowEveryone onPress={onEveryone} />} />;
  }
  if (whose === "everyone") return <EmptyState pose="searching" title={`No missions in the last ${days} days`} description="Nobody here has started one." />;
  if (whose === "unknown") return <EmptyState pose="searching" title="None without a person" description={`Every mission of the last ${days} days belongs to someone in People.`} />;
  if (whose !== "mine") return <EmptyState pose="searching" title="Nothing of theirs" description={`They started no mission in the last ${days} days, and none reports to a chat of theirs.`} />;
  return (
    <EmptyState
      pose="sleeping"
      title={agent ? `${agent} has no missions in the last ${days} days` : `No missions in the last ${days} days`}
      description="Start one here, or send /mission and a goal in a chat. An agent also starts one when a piece of work needs hours rather than a reply."
    />
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
  // An admin reads their own unless they pick otherwise beside the search; anyone else has their own, and no choice.
  const { whose, setWhose, canPick } = useWhose("missions");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const list = useQuery({
    queryKey: ["missions", "list", agent ?? "", days, whose],
    queryFn: () => api.missions(agent, days, whose),
    refetchInterval: (query) => (anyOpen(query.state.data?.missions ?? []) ? OPEN_MS : SETTLED_MS),
    // The page keeps its head while another list is on its way: the picker just pressed is not drawn anew.
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Who the reader is in People: theirs come first where the list is set apart by person.
  const self = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe, staleTime: 60_000, enabled: canPick });
  const writable = canWrite(me.data ?? null);
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (entry) => entry.id);
  // What the page holds: the list asked for, or the one before it while that is on its way, which is not drawn.
  const held = list.data?.missions ?? [];
  const arriving = list.isPlaceholderData;
  const missions = arriving ? [] : held;
  const found = useTextFilter(missions, filter, searchedIn);

  if (list.isLoading) {
    return <ListLoading shape="cards" />;
  }

  const failed = list.error && !list.data ? list.error : null;
  // "Not run here" only when the daemon says so (501) — a boot's 503 or a timeout is an error, said as one.
  if (failed instanceof ApiError && failed.status === 501) {
    return (
      <div className="alert alert-warning rounded-2xl border border-warning/30 bg-warning/10 p-4 text-warning">
        <AlertTriangle size={18} />
        <span>Missions are not turned on for this server.</span>
      </div>
    );
  }

  const counts: Record<MissionTab, number> = { all: held.length, needs_you: 0, working: 0, done: 0, failed: 0, stopped: 0 };
  for (const mission of held) counts[tabOf(mission)] += 1;
  const current = TABS.find((entry) => entry.id === tab)!;
  const matched = new Set(found);
  const shown = (mission: MissionView) => matched.has(mission);
  // How many more an admin's own list leaves out: the daemon's count, and only of the list now on the page.
  const elsewhere = !failed && !arriving ? (list.data?.elsewhere ?? 0) : 0;
  const everyone = () => setWhose("everyone");
  const listed = {
    missions,
    tab,
    shown,
    empty:
      missions.length === 0 && tab === "all" ? (
        noMissions({ whose, days, agent, elsewhere, onEveryone: everyone })
      ) : counts[tab] === 0 ? (
        <EmptyState pose="sleeping" title={current.none(days)} />
      ) : (
        <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
      ),
  };

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        ask={PAGE_ASKS.missions}
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
        {...(held.length > 0 ? { search: { value: filter, onChange: setFilter, placeholder: "Search missions" } } : {})}
        actions={<MissionFilters picker={canPick ? { whose, setWhose } : null} days={days} onDays={setDays} agent={agent} agents={agents.map((entry) => entry.id)} />}
      >
        {failed ? (
          <ErrorNote error={failed} />
        ) : arriving ? (
          <ListLoading shape="cards" />
        ) : whose === "mine" ? (
          <MissionList {...listed} />
        ) : (
          // Set apart by person wherever it is not the reader's own list: the person looked at first, or the reader.
          <MissionsByPerson {...listed} first={whose.startsWith("person:") ? whose.slice("person:".length) : self.data?.person?.key} />
        )}
        {elsewhere > 0 && held.length > 0 ? (
          <div className="pt-5">
            <Elsewhere count={elsewhere} onEveryone={everyone} />
          </div>
        ) : null}
      </ScrollCard>
    </div>
  );
}
