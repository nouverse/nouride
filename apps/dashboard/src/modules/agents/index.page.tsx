/**
 * Every agent, and the state each is in.
 * Designed with Apple HIG: sleek cards with subtle borders, tactile feedback,
 * glowing status indicators, and clear metadata.
 */

import { AgentStatusBadge } from "@/commons/components/agents/agent-status-badge";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, ChevronRight, Crown, KeyRound, Plus, Radio, Settings, Wrench } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { FILL_PAGE, ScrollArea } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { agentModel, orchestratorFirst } from "@/commons/lib/agents";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { NewAgentForm } from "./components/NewAgentForm";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { LIFTS } from "@/commons/components/ui/CardGrid";
import { cn } from "@/commons/lib/utils";
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
  const shown = agents.filter((agent) => inFilter(agent, filter));

  // Only against a list that loaded: with none, every connection would read as belonging to nobody.
  const orphans = (status.data ? (gateways.data?.gateways ?? []) : []).filter(
    (gateway) => !gateway.agent || !agents.some((agent) => agent.id === gateway.agent),
  );

  return (
    <div className={FILL_PAGE}>
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
        <SegmentedTabs
          tabs={AGENT_FILTERS.map((entry) => ({ value: entry.id, label: entry.label, after: <Count n={counts[entry.id]} highlight={entry.id === "unavailable" && counts.unavailable > 0} /> }))}
          value={filter}
          onChange={setFilter}
        />
        {shown.length === 0 ? <EmptyState pose="searching" title={`No ${filter} agents`} /> : null}
        {/* Its own scroll, so the tabs stay put over a long list. Keyed by the tab, to fade in anew (`FILL_PAGE`). */}
        <ScrollArea key={filter} fill className="pr-1">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {shown.map((agent) => {
            const connections = (gateways.data?.gateways ?? []).filter(
              (gateway) => gateway.agent === agent.id,
            );
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })}
                className={cn(
                  "group relative flex flex-col justify-between text-left rounded-2xl border border-base-content/[0.08] bg-base-100/80 backdrop-blur-xl p-5 shadow-xs hover:border-primary/40 hover:shadow-md active:scale-[0.98]",
                  LIFTS,
                )}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-bold text-base tracking-tight text-base-content group-hover:text-primary transition-colors">
                          {agent.displayName}
                        </span>
                        {agent.id === orchestrator && (
                          <span className="badge badge-xs badge-primary gap-1 font-semibold px-2 py-1 shadow-xs font-mono">
                            <Crown size={10} /> orchestrator
                          </span>
                        )}
                      </div>
                      <p className="text-base-content/65 truncate font-mono text-xs mt-0.5">{agent.id}</p>
                      {agent.headline ? <p className="mt-1.5 line-clamp-2 text-xs text-base-content/75" title={agent.headline}>{agent.headline}</p> : null}
                    </div>

                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      <AgentStatusBadge agent={agent} />
                    </div>
                  </div>

                  <div className="mt-4 p-2.5 rounded-xl bg-base-200/50 border border-base-content/[0.05]">
                    {/* An external agent's model is its CLI's: what answers it is the CLI, on its account. */}
                    <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 block mb-0.5 font-mono">{agent.external ? "Coding CLI" : "Model"}</span>
                    <p className="text-base-content/85 truncate font-mono text-xs font-medium" title={agentModel(agent)}>{agent.external ? `${agentModel(agent)} · account ${agent.external.profile}` : agent.model}</p>
                    {/* Why it cannot answer — not signed in, not installed — on the card, before anyone opens it. */}
                    {agent.external && agent.activity?.unavailable ? (
                      <p className="text-warning mt-1 flex items-center gap-1 text-[11px]" title={agent.activity.unavailable}>
                        <KeyRound size={11} className="shrink-0" aria-hidden="true" /> <span className="truncate">{agent.activity.unavailable}</span>
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="text-base-content/65 mt-4 flex items-center justify-between gap-2 text-xs pt-3 border-t border-base-content/[0.05]">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Radio size={13} className="text-primary/70" />
                      {connections.length === 0
                        ? "No connections"
                        : connections.map((c) => c.platform).join(", ")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Wrench size={12} className="opacity-60" />
                      {agent.tools.length} tools
                    </span>
                  </div>

                  <ChevronRight
                    size={16}
                    className="text-base-content/40 transition-transform group-hover:translate-x-1 group-hover:text-primary"
                  />
                </div>
              </button>
            );
          })}
        </div>
        </ScrollArea>
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
