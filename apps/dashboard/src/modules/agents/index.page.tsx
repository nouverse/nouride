/**
 * Every agent, and the state each is in.
 * Designed with Apple HIG: sleek cards with subtle borders, tactile feedback,
 * glowing status indicators, and clear metadata.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertTriangle, Plus, Settings } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { agentModel, orchestratorFirst } from "@/commons/lib/agents";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { NewAgentForm } from "./components/NewAgentForm";
import { AgentRows, PickedAgent } from "./components/AgentRows";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { StickyBar } from "@/commons/components/ui/StickyBar";
import { OfficeView } from "@/commons/office/components/OfficeView";
import { looksOf } from "@/commons/cat/look";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

export default function AgentListPage() {
  // Polled while the page is open, so what each agent is doing stays true; not in a hidden tab.
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 10_000 });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const orchestrator = status.data?.orchestrator ?? null;
  const agents = orchestratorFirst(status.data?.agents ?? [], orchestrator);
  // Making an agent is an admin's, as the daemon's route is: it can be given every tool and a coding CLI.
  const admin = isAdmin(me.data ?? null);

  const [filter, setFilter] = useState<AgentFilter>("all");
  const counts = Object.fromEntries(AGENT_FILTERS.map((entry) => [entry.id, agents.filter((agent) => inFilter(agent, entry.id)).length])) as Record<AgentFilter, number>;
  // By its name, its id, what answers it or what it is for: with many agents, the one wanted is typed, not looked for.
  const [query, setQuery] = useState("");
  const listed = useTextFilter(agents.filter((agent) => inFilter(agent, filter)), query, (agent) => [agent.displayName, agent.id, agent.headline, agentModel(agent)]);
  /**
   * The agent shown, and where: a cat picked in the Office has its card right under the Office, where the press was;
   * a row pressed opens under that row. One at a time: the same agent's actions are never on the page twice.
   */
  const [shown, setShown] = useState<{ agentId: string; at: "office" | "row" } | null>(null);
  const pick = (agentId: string | null) => setShown(agentId ? { agentId, at: "office" } : null);
  const openRow = (agentId: string | null) => setShown(agentId ? { agentId, at: "row" } : null);
  const platformsOf = (agentId: string) => (gateways.data?.gateways ?? []).filter((gateway) => gateway.agent === agentId).map((gateway) => gateway.platform);
  const picked = shown?.at === "office" ? agents.find((agent) => agent.id === shown.agentId) : undefined;
  // From every agent: an agent's look is the same here, in the Office and on its Look tab.
  const looks = useMemo(() => looksOf(status.data?.agents ?? []), [status.data]);

  // Only against a list that loaded: with none, every connection would read as belonging to nobody.
  const orphans = (status.data ? (gateways.data?.gateways ?? []) : []).filter(
    (gateway) => !gateway.agent || !agents.some((agent) => agent.id === gateway.agent),
  );

  return (
    <div className="space-y-6 *:animate-fade">
      <PageHeader
        ask={PAGE_ASKS.agents}
        title="Agents"
        description="Each agent has its own personality, AI model, chat connections and tools."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/agents/settings"
              className="btn btn-ghost btn-sm gap-2 shadow-xs active:scale-95 transition-all"
            >
              <Settings size={16} /> Settings
            </Link>
            <button
              type="button"
              className="btn btn-primary btn-sm gap-2 shadow-xs active:scale-95 transition-all"
              disabled={!admin}
              onClick={() => setCreating(true)}
            >
              <Plus size={16} /> New Agent
            </button>
          </div>
        }
      />

      {creating && (
        <NewAgentForm
          onClose={() => setCreating(false)}
          onCreated={async (id, external) => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: ["status"] });
            // An agent a coding CLI answers goes to its Brain tab, where it signs in.
            void navigate(external ? { to: "/agents/$agentId/cli", params: { agentId: id } } : { to: "/agents/$agentId", params: { agentId: id } });
          }}
        />
      )}

      {orphans.length > 0 && (
        <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-2xl p-4 shadow-xs">
          <AlertTriangle size={18} className="shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">
              {orphans.length} unassigned connection{orphans.length === 1 ? "" : "s"}
            </p>
            <p className="opacity-85 mt-0.5">
              {orphans.map((g) => g.id).join(", ")} have no agent to answer them. Pick one on an agent's Connections tab.
            </p>
          </div>
        </div>
      )}

      {/*
        A failed load says so, and is not drawn as an empty install. During a restart or on a wedged box
        `agents` is [] because nothing arrived, and "No agents configured — create your first" was a claim
        the page could not make, with a button inviting a duplicate.
      */}
      {status.isPending ? (
        <ListLoading shape="cards" />
      ) : status.error && !status.data ? (
        <ErrorNote error={status.error} />
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            pose="ready"
            title="No agents yet"
            description="Make your first agent to start talking with it, here or in your chat apps."
            action={
              <button
                type="button"
                className="btn btn-primary btn-sm gap-2 shadow-xs active:scale-95 transition-all"
                disabled={!admin}
                onClick={() => setCreating(true)}
              >
                <Plus size={16} /> New Agent
              </button>
            }
          />
        </Card>
      ) : (
        <>
          {/* The office first: who is doing what, at a glance. Picking a cat shows that agent right under it. */}
          <OfficeView selected={picked ? picked.id : null} onSelect={pick} />
          {picked ? <PickedAgent row={{ agent: picked, platforms: platformsOf(picked.id) }} orchestrator={orchestrator} look={looks.get(picked.id)} onClose={() => setShown(null)} /> : null}
          {/* The filter and the search stay at the top of the window while the list scrolls under them. */}
          <StickyBar
            label="Which agents"
            tools={agents.length > 5 ? <SearchInput value={query} onChange={setQuery} placeholder="Search agents" className="w-48" /> : undefined}
          >
            <SegmentedTabs
              tabs={AGENT_FILTERS.map((entry) => ({ value: entry.id, label: entry.label, after: <Count n={counts[entry.id]} highlight={entry.id === "unavailable" && counts.unavailable > 0} /> }))}
              value={filter}
              onChange={setFilter}
            />
          </StickyBar>
          {listed.length === 0 ? (
            <EmptyState pose="searching" title={query.trim() ? `Nothing matches “${query}”` : `No ${filter} agents`} />
          ) : (
            // Keyed by the filter, so the list it narrows is drawn anew and fades in.
            <div key={filter}>
              <AgentRows
                rows={listed.map((agent) => ({ agent, platforms: platformsOf(agent.id) }))}
                orchestrator={orchestrator}
                looks={looks}
                open={shown?.at === "row" ? shown.agentId : null}
                onOpen={openRow}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

type AgentFilter = "all" | "active" | "idle" | "asleep" | "unavailable";
const AGENT_FILTERS: { id: AgentFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "idle", label: "Idle" },
  { id: "asleep", label: "Asleep" },
  { id: "unavailable", label: "Unavailable" },
];

/**
 * Which tab an agent is under, from what `/status` says it is doing: active is working or waiting for you, and
 * unavailable is one that could not work if asked — whatever it is doing. A daemon before 0.7.18 sends only the pack's
 * state, read here as idle when running and paused otherwise.
 */
function inFilter(agent: AgentSummary, filter: AgentFilter): boolean {
  const activity = agent.activity?.activity ?? (agent.state === "running" ? "idle" : "asleep");
  switch (filter) {
    case "active":
      return activity === "working" || activity === "waiting";
    case "idle":
      return activity === "idle";
    case "asleep":
      return activity === "asleep";
    case "unavailable":
      return Boolean(agent.activity?.unavailable);
    default:
      return true;
  }
}
