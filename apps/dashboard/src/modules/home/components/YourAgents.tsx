/**
 * Your agents, on Home (0.8.24): each one's own cat, its name and what it does, and what it is doing now. Opens the
 * agent; the Office, the same agents drawn at work, is a tab beside Agents.
 */

import { LIFTS } from "@/commons/components/ui/CardGrid";
import { Link } from "@tanstack/react-router";
import type { Look } from "@/commons/cat/look";
import type { AgentSummary } from "@/commons/lib/api";
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

export function YourAgents({ agents, looks }: { agents: AgentSummary[]; looks: Map<string, Look> }) {
  if (agents.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xl text-base-content">Your agents</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {agents.map((agent) => {
          const look = looks.get(agent.id);
          const now = doingNow(agent);
          const name = agent.displayName || agent.id;
          return (
            <Link key={agent.id} to="/agents/$agentId" params={{ agentId: agent.id }} className={cn("flex items-center gap-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-3 shadow-soft", LIFTS)}>
              {look && <AgentAvatar look={look} name={name} />}
              <span className="min-w-0 flex-1">
                {/* The name whole, and what it does cut short after it: a long line about an agent cut its name to "N…" on
                    the box's seven agents. */}
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 font-display text-lg font-medium text-base-content">{name}</span>
                  {agent.headline && <span className="min-w-0 truncate text-xs text-base-content/65">{agent.headline}</span>}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-base-content/70">
                  <span className={cn("size-2 shrink-0 rounded-full", DOT[now.tone])} aria-hidden="true" />
                  <span className="truncate">{now.words}</span>
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
