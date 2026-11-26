/**
 * One agent, and everything that belongs to it.
 * Remade with Apple HIG: sleek breadcrumb navigation, tactile controls,
 * state indicators, and an elegant segmented tab bar.
 */

import { AgentStatusBadge } from "@/commons/components/agents/agent-status-badge";
import { OpenBadge } from "@/commons/components/agents/AgentName";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Cpu,
  Crown,
  FileText,
  FolderOpen,
  KeyRound,
  Palette,
  Pause,
  Play,
  Plug,
  Radio,
  RotateCw,
  SlidersHorizontal,
  Target,
  Terminal,
} from "lucide-react";
import { usePageSubject } from "@/commons/hooks/use-page-subject";
import { api } from "@/commons/lib/api";
import { agentModel } from "@/commons/lib/agents";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { SEGMENTED_BAR, segmentClass, useSelectedInView } from "@/commons/components/ui/SegmentedTabs";
import { StickyBar } from "@/commons/components/ui/StickyBar";
import { DetailLoading } from "@/commons/components/ui/Skeleton";

interface Tab {
  to:
    | "/agents/$agentId"
    | "/agents/$agentId/model"
    | "/agents/$agentId/gateways"
    | "/agents/$agentId/access"
    | "/agents/$agentId/skills"
    | "/agents/$agentId/mcp"
    | "/agents/$agentId/cli"
    | "/agents/$agentId/look"
    | "/agents/$agentId/workspace"
    | "/agents/$agentId/settings";
  label: string;
  icon: typeof FileText;
  exact?: boolean;
}

const TABS: Tab[] = [
  { to: "/agents/$agentId", label: "Files", icon: FileText, exact: true },
  { to: "/agents/$agentId/model", label: "Model", icon: Cpu },
  { to: "/agents/$agentId/gateways", label: "Connections", icon: Radio },
  { to: "/agents/$agentId/access", label: "Access", icon: KeyRound },
  { to: "/agents/$agentId/skills", label: "Skills", icon: BookOpen },
  { to: "/agents/$agentId/mcp", label: "Connectors", icon: Plug },
  { to: "/agents/$agentId/settings", label: "Settings", icon: SlidersHorizontal },
  // Its cat in the Office (0.8.1).
  { to: "/agents/$agentId/look", label: "Look", icon: Palette },
];

/**
 * An external agent's tab (0.8.1): its brain — the coding CLI, its account, its model and how it runs, and below, the
 * model Nouride's own work around it runs on. One tab in place of CLI and Model, which a person read as two answers.
 */
const BRAIN_TAB: Tab = { to: "/agents/$agentId/cli", label: "Brain", icon: Terminal };

/** Its own folder in the workspace, to look through: an admin's, as System's Files is. */
const WORKSPACE_TAB: Tab = { to: "/agents/$agentId/workspace", label: "Workspace", icon: FolderOpen };

export default function AgentLayoutPage({ agentId }: { agentId: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Polled while the page is open, so what the agent is doing stays true; not in a hidden tab.
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 10_000 });
  const me = useMe();
  const queryClient = useQueryClient();

  const agent = (status.data?.agents ?? []).find((entry) => entry.id === agentId);
  // Which agent these pages are about, for one asked from the chat that floats over them.
  usePageSubject(agent ? agent.displayName || agent.id : undefined);
  const editable = canWrite(me.data ?? null);
  // Keyed on the agent too: the bar is drawn only once it is known, after the first render.
  const tabBar = useSelectedInView<HTMLDivElement>(`${pathname} ${Boolean(agent)}`);

  const makeDefault = useMutation({
    mutationFn: () => api.setOrchestrator(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const act = useMutation({
    mutationFn: (action: "sleep" | "wake" | "reload") => api.agentAction(agentId, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  if (status.isPending) return <DetailLoading />;

  if (!agent) {
    return (
      <div className="space-y-4">
        <Link to="/agents" className="btn btn-ghost btn-sm gap-2 rounded-xl">
          <ArrowLeft size={15} /> All Agents
        </Link>
        <div className="alert alert-error bg-error/10 border border-error/30 text-error rounded-2xl p-4">
          <span>No agent found matching “{agentId}”.</span>
        </div>
      </div>
    );
  }

  return (
    // A tab's page fades in as it is drawn (`*:animate-fade`); the header above it stays where it is.
    <div className="space-y-6 *:animate-fade">
      <div className="space-y-4">
        <Link
          to="/agents"
          className="text-base-content/65 hover:text-base-content inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider transition-colors active:scale-95 font-mono max-sm:min-h-8"
        >
          <ArrowLeft size={13} /> Back to Agents
        </Link>

        {/* Header with Title & Action Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            {/* A long name wraps under itself, and the badges go to the next line whole rather than squeezed. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="min-w-0 text-2xl font-bold tracking-tight text-base-content [overflow-wrap:anywhere] sm:text-3xl">
                {agent.displayName}
              </h1>
              <AgentStatusBadge agent={agent} />
              {agent.access === "open" ? <OpenBadge size="sm" /> : null}
              {agent.external ? (
                <span className="badge badge-sm badge-ghost gap-1 font-mono" title="It answers through this coding CLI, on this model">
                  <Terminal size={11} /> {agentModel(agent)}
                </span>
              ) : null}
              {/* One orchestrator at a time: the agent a message reaches when nothing names another. Never an external one,
                  nor one open to everyone, which the daemon refuses too: offered, the press would only be told no. */}
              {status.data?.orchestrator === agent.id ? (
                <span className="badge badge-sm badge-primary gap-1 font-semibold font-mono">
                  <Crown size={11} /> orchestrator
                </span>
              ) : isAdmin(me.data ?? null) && !agent.external && agent.access !== "open" ? (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost rounded-lg gap-1 font-medium text-base-content/65 hover:text-base-content"
                  disabled={makeDefault.isPending}
                  onClick={() => makeDefault.mutate()}
                  title="Answers messages that name no agent, is the front desk of rooms with several of your bots, and is listed first"
                >
                  <Crown size={11} /> Make orchestrator
                </button>
              ) : null}
            </div>
            <p className="text-base-content/65 font-mono text-sm">{agent.id}</p>
            {/* What its peers read about it; changed on its Settings tab. */}
            {agent.headline ? <p className="max-w-2xl text-sm text-base-content/75">{agent.headline}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Its long work, on the Missions list narrowed to it (0.8.0). */}
            <Link
              to="/missions"
              search={{ agent: agent.id }}
              className="btn btn-sm btn-ghost bg-base-100 border border-base-content/10 rounded-xl gap-2 font-medium shadow-xs hover:bg-base-200 active:scale-95 transition-all"
            >
              <Target size={14} /> Missions
            </Link>
            <button
              type="button"
              className="btn btn-sm btn-ghost bg-base-100 border border-base-content/10 rounded-xl gap-2 font-medium shadow-xs hover:bg-base-200 active:scale-95 transition-all"
              disabled={!editable || act.isPending}
              onClick={() => act.mutate(agent.state === "paused" ? "wake" : "sleep")}
            >
              {agent.state === "paused" ? (
                <>
                  <Play size={14} className="text-success" /> Wake
                </>
              ) : (
                <>
                  <Pause size={14} className="text-warning" /> Sleep
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost bg-base-100 border border-base-content/10 rounded-xl gap-2 font-medium shadow-xs hover:bg-base-200 active:scale-95 transition-all"
              disabled={!editable || act.isPending}
              onClick={() => act.mutate("reload")}
              title="Read this agent's files again"
            >
              <RotateCw size={14} className={act.isPending ? "animate-spin" : ""} /> Reload
            </button>
          </div>
        </div>

        <ErrorNote error={act.error ?? makeDefault.error} />

      </div>

      {/* Its tabs stay at the top of the window while the tab's page scrolls under them. Outside the header's own
          block: a row that stays is held by the block it is in, and inside the header it left with it. */}
      <StickyBar label="This agent's pages">
        <div ref={tabBar} className={SEGMENTED_BAR}>
          {/* Its files, what answers it, then its own folder for an admin: Workspace beside Model, or Brain in its place. */}
          {[TABS[0]!, agent.external ? BRAIN_TAB : TABS[1]!, ...(isAdmin(me.data ?? null) ? [WORKSPACE_TAB] : []), ...TABS.slice(2)].map(({ to, label, icon: Icon, exact }) => {
            const target = to.replace("$agentId", agentId);
            const active = exact ? pathname === target : pathname.startsWith(target);
            return (
              <Link
                key={to}
                to={to}
                params={{ agentId }}
                // Marked current as it is drawn: by default the router marks Files current on every tab, its route
                // being every tab's parent — and the tab bar scrolls the current one into view on a phone.
                activeOptions={{ exact: Boolean(exact) }}
                className={segmentClass(active)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      </StickyBar>

      <Outlet />
    </div>
  );
}
