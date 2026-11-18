/**
 * Missions as a board: Backlog, Working, Needs you, Finished, read only, since a mission moves on its own.
 * Four columns on a wide window and four tabs with their counts on a phone, opening on Needs you when it holds any. What
 * is open is listed however old; Finished goes back its own span, 7, 14, 21 or 30 days, 7 unless chosen. A search, an
 * agent and, for an admin, whose missions narrow every column.
 *
 * The list is the reader's own: what they started, and what reports to a chat of theirs. An admin picks whose beside
 * the search, as on Chats; on a list that is not their own, each card says whose it is. Under an admin's own list a line
 * says how many more there are, so a short list is not read as the rest being gone.
 *
 * Asked again every few seconds while anything can still change, and only as a slow net once nothing can; a hidden tab
 * asks for nothing, which is the query client's own rule for an interval.
 */

import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, SlidersHorizontal, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { canWrite, useMe } from "@/commons/lib/session";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { Elsewhere, elsewhereWords, ShowEveryone } from "@/commons/components/people/Elsewhere";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { StickyBar } from "@/commons/components/ui/StickyBar";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { useWhose, type Whose } from "@/commons/hooks/use-whose";
import { useWide } from "@/commons/hooks/use-wide";
import { MissionFilters } from "./components/MissionFilters";
import { MissionBoard } from "./components/MissionBoard";
import { MissionSettingsCard } from "./components/MissionSettingsCard";
import { NewMissionForm } from "./components/NewMissionForm";
import { anyOpen, searchedIn } from "./lib/mission";
import { boardSummary, columnOf, COLUMNS, FINISHED_SPAN, fromLink, phoneOpening, type Column, type FinishedSpan, type Outcome } from "./lib/board";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

/** While something is working or waiting on a person; a finished list changes only when somebody starts one. */
const OPEN_MS = 5_000;
const SETTLED_MS = 30_000;

/**
 * What a page with no missions says. The reader's own: how one is started; with others' left out of it (`elsewhere`),
 * how many, and the press that lists them, so an empty page is not read as everything gone. Where an admin looked at
 * someone else's: whose was looked at, not how to start one.
 */
function noMissions({ whose, days, agent, elsewhere, onEveryone }: { whose: Whose; days: number; agent: string | undefined; elsewhere: number; onEveryone: () => void }): ReactNode {
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
      description="Start one here, or ask an agent for one in a chat: it writes a draft, which runs once you start it."
    />
  );
}

export default function MissionsPage({ agent, tab }: { agent?: string; tab?: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const linked = fromLink(tab);
  const [days, setDays] = useState<FinishedSpan>(FINISHED_SPAN);
  const [outcome, setOutcome] = useState<Outcome | null>(linked?.outcome ?? null);
  // The phone's column: the one a link named, else picked once the list is read (`phoneOpening`), then the person's.
  const [picked, setColumn] = useState<Column | null>(linked?.column ?? null);
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
  const writable = canWrite(me.data ?? null);
  // On a phone "+ New" stands beside the title, as the mockup the owner signed off draws it.
  const wide = useWide();
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (entry) => entry.id);
  // What the page holds: the list asked for, or the one before it while that is on its way, which is not drawn.
  const held = list.data?.missions ?? [];
  const arriving = list.isPlaceholderData;
  const missions = arriving ? [] : held;
  const found = useTextFilter(missions, filter, searchedIn);
  const matched = new Set(found);

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

  const counts = Object.fromEntries(COLUMNS.map((column) => [column.id, 0])) as Record<Column, number>;
  for (const mission of held) counts[columnOf(mission)] += 1;
  // How many more an admin's own list leaves out: the daemon's count, and only of the list now on the page.
  const elsewhere = !failed && !arriving ? (list.data?.elsewhere ?? 0) : 0;
  const everyone = () => setWhose("everyone");
  const newMission = (
    <button
      type="button"
      className="btn btn-primary btn-sm min-h-11 gap-2 rounded-xl shadow-xs transition-all active:scale-95 sm:min-h-8"
      disabled={!writable}
      onClick={() => setCreating((open) => !open)}
    >
      {creating ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
      {creating ? "Close" : wide ? "New mission" : "New"}
    </button>
  );

  return (
    <div className="space-y-6 *:animate-fade">
      <div className="flex items-start justify-between gap-3">
        <PageHeader ask={PAGE_ASKS.missions} title="Missions" description={boardSummary(counts)} className="min-w-0 flex-1" />
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm min-h-11 gap-2 rounded-xl max-sm:hidden sm:min-h-8"
            aria-expanded={limitsOpen}
            onClick={() => setLimitsOpen((open) => !open)}
          >
            {limitsOpen ? <X size={15} aria-hidden="true" /> : <SlidersHorizontal size={15} aria-hidden="true" />}
            {limitsOpen ? "Close limits" : "Limits"}
          </button>
          {newMission}
        </div>
      </div>

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

      {/* The search and the filters stay at the top of the window while the board scrolls under them. */}
      <StickyBar
        label="Which missions"
        tools={
          <>
            <SearchInput value={filter} onChange={setFilter} placeholder="Search missions" className="w-full max-sm:h-11 sm:w-64" />
            <MissionFilters picker={canPick ? { whose, setWhose } : null} agent={agent} agents={agents.map((entry) => entry.id)} />
          </>
        }
      />

      {failed ? (
        <ErrorNote error={failed} />
      ) : arriving ? (
        <ListLoading shape="cards" />
      ) : (
        <MissionBoard
          empty={held.length === 0 && !filter ? noMissions({ whose, days, agent, elsewhere, onEveryone: everyone }) : undefined}
          missions={missions}
          shown={(mission) => matched.has(mission)}
          counts={counts}
          writable={writable}
          showWhose={whose !== "mine"}
          state={{ column: picked ?? phoneOpening(counts), setColumn, days, setDays, outcome, setOutcome }}
        />
      )}
      {elsewhere > 0 && held.length > 0 ? <Elsewhere count={elsewhere} onEveryone={everyone} /> : null}
    </div>
  );
}
