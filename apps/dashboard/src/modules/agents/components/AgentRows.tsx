/**
 * The agents as a list of rows under the Office: each agent a line (its cat, its name, what it is doing, what answers
 * it, where it is reached) that opens its page, with a part that opens under it for what a person does with it.
 *
 * They were cards, two across and five lines tall, so seven agents ran past the window and the page under the Office
 * would have been all scroll. A row is one line; opened, it shows the agent's actions in the one place they are.
 */

import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Crown, KeyRound, Radio } from "lucide-react";
import type { AgentSummary } from "@nouride/wire";
import type { Look } from "@/commons/cat/look";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { AgentStatusBadge } from "@/commons/components/agents/agent-status-badge";
import { agentModel } from "@/commons/lib/agents";
import { statusOf } from "@/commons/office/lib/status";
import { cn } from "@/commons/lib/utils";
import { AgentActions } from "./AgentActions";

export interface AgentRow {
  agent: AgentSummary;
  /** The platforms it is reached on, as its connections name them. */
  platforms: string[];
}

export function AgentRows({ rows, orchestrator, looks, open, onOpen }: { rows: AgentRow[]; orchestrator: string | null; looks: Map<string, Look>; open: string | null; onOpen: (agentId: string | null) => void }) {
  const opened = useRef<HTMLLIElement | null>(null);
  // Opened from the Office above: brought into view, so the cat picked and its actions are seen together.
  useEffect(() => {
    if (open) opened.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <ul className="divide-y divide-base-content/[0.06] overflow-hidden rounded-2xl border border-base-content/[0.08] bg-base-100 shadow-xs" data-agent-rows>
      {rows.map(({ agent, platforms }) => {
        const name = agent.displayName || agent.id;
        const look = looks.get(agent.id);
        const isOpen = open === agent.id;
        return (
          <li key={agent.id} ref={isOpen ? opened : undefined} data-agent-row={agent.id} className={cn("scroll-mt-20", isOpen && "bg-secondary/[0.04]")}>
            <div className="flex items-center gap-1 pr-2">
              <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="group flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 sm:px-4" title={agent.headline ? `${name}: ${agent.headline}` : name}>
                {look ? <AgentAvatar look={look} name={name} size="sm" className="shrink-0 rounded-full" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-base-content transition-colors group-hover:text-primary">{name}</span>
                    {agent.id === orchestrator ? (
                      <span className="badge badge-xs badge-primary shrink-0 gap-1 px-2 py-1 font-mono font-semibold">
                        <Crown size={10} aria-hidden="true" /> orchestrator
                      </span>
                    ) : null}
                  </span>
                  {/* What answers it, then where it is reached: an external agent's model is its CLI's, on its account. */}
                  <span className="mt-0.5 flex min-w-0 items-center gap-x-3 font-mono text-[11px] text-base-content/65">
                    <span className="truncate" title={agentModel(agent)}>
                      {agent.external ? `${agentModel(agent)} · account ${agent.external.profile}` : agentModel(agent)}
                    </span>
                    <span className="hidden shrink-0 items-center gap-1 sm:flex">
                      <Radio size={11} aria-hidden="true" /> {platforms.length === 0 ? "no connections" : platforms.join(", ")}
                    </span>
                  </span>
                  {/* Why it cannot answer (not signed in, not installed), before anyone opens it. */}
                  {agent.external && agent.activity?.unavailable ? (
                    <span className="mt-0.5 flex items-center gap-1 text-[11px] text-warning" title={agent.activity.unavailable}>
                      <KeyRound size={11} className="shrink-0" aria-hidden="true" /> <span className="truncate">{agent.activity.unavailable}</span>
                    </span>
                  ) : null}
                </span>
                <AgentStatusBadge agent={agent} />
                <ChevronRight size={16} className="hidden shrink-0 text-base-content/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary sm:block" aria-hidden="true" />
              </Link>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-circle shrink-0"
                aria-expanded={isOpen}
                aria-label={isOpen ? `Close ${name}'s actions` : `What to do with ${name}`}
                onClick={() => onOpen(isOpen ? null : agent.id)}
              >
                <ChevronDown size={16} className={cn("transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
              </button>
            </div>
            {isOpen ? (
              <div className="px-3 pb-3 sm:px-4 sm:pl-[4.25rem]">
                <AgentActions agent={agent} status={statusOf(agent)} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
