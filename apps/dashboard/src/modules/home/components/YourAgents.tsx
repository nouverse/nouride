/**
 * Your agents, on Home (0.8.24): each one's own cat and whole name as a chip beside the Office's picture, and a dot
 * for what it is doing now. Opens the agent.
 */

import { Link } from "@tanstack/react-router";
import { Crown } from "lucide-react";
import type { Look } from "@/commons/cat/look";
import type { AgentSummary } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { cn } from "@/commons/lib/utils";

/** What an agent is doing, in a few words, and the dot's colour for it. */
export function doingNow(agent: AgentSummary): { words: string; tone: "success" | "accent" | "muted" } {
  if (!agent.enabled || agent.state !== "running") return { words: agent.enabled ? "Not running" : "Switched off", tone: "muted" };
  const activity = agent.activity;
  if (!activity) return { words: "Ready", tone: "success" };
  if (activity.unavailable) return { words: activity.unavailable, tone: "muted" };
  if (activity.activity === "waiting") return { words: "Waiting for you", tone: "accent" };
  const missions = activity.missions ?? 0;
  if (missions > 0) return { words: missions === 1 ? "1 mission running" : `${missions} missions running`, tone: "success" };
  if (activity.activity === "working") return { words: "Working", tone: "success" };
  if (activity.activity === "asleep") return { words: "Asleep", tone: "muted" };
  return { words: "Idle", tone: "muted" };
}

const DOT = { success: "bg-success", accent: "bg-accent", muted: "bg-base-content/30" } as const;

/**
 * Each agent as a chip: its cat, its whole name, the crown on the orchestrator, and a dot for what it is doing, said in
 * words to whoever points at it or reads it aloud. Compact where a card each filled Home.
 */
export function AgentChips({ agents, orchestrator, looks }: { agents: AgentSummary[]; orchestrator: string | null; looks: Map<string, Look> }) {
  return (
    <ul className="flex min-w-0 flex-1 flex-wrap gap-2">
      {agents.map((agent) => {
        const look = looks.get(agent.id);
        const now = doingNow(agent);
        const name = agent.displayName || agent.id;
        return (
          <li key={agent.id}>
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              title={agent.headline ? `${name}: ${agent.headline}` : name}
              className="flex items-center gap-2 rounded-full border border-base-content/[0.08] bg-base-100 py-1 pr-3 pl-1 transition-colors hover:border-secondary/30 hover:bg-secondary/5"
            >
              {look && <AgentAvatar look={look} name={name} size="xs" className="rounded-full" />}
              <span className="shrink-0 text-sm font-semibold text-base-content">{name}</span>
              {agent.id === orchestrator && <Crown size={12} className="shrink-0 text-secondary" aria-label="orchestrator" />}
              <span className={cn("size-2 shrink-0 rounded-full", DOT[now.tone])} aria-hidden="true" />
              <span className="sr-only">{now.words}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
