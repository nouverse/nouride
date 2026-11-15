/**
 * The agents as a list of rows under the Office: each agent a line (its cat, its name, what it is doing, what answers
 * it, where it is reached). A press anywhere on the line opens a part under it with what a person does with that agent,
 * its page first (Details).
 *
 * They were cards, two across and five lines tall, so seven agents ran past the window and the page under the Office
 * would have been all scroll. A row is one line; opened, it shows the agent's actions in the one place they are.
 *
 * A row was two things to press: the line went to the agent's page and a small arrow at its end opened the part under
 * it, so a press meant for one took the other. And every row that opened was brought into view, the one under the
 * pointer too, which moved the page under a hand that had just pressed it. A row is one press now, and the page moves
 * only for a cat picked in the Office whose row is not on the screen at all.
 */

import { useEffect, useRef } from "react";
import { ChevronDown, Crown, KeyRound, Radio } from "lucide-react";
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

/** How much of the window's top the row that stays covers: a row under it is not seen. */
const UNDER_THE_BAR = 64;

/** Whether nothing of a row is on the screen: above what the window shows (or under the row that stays), or below it. */
export function outOfView(row: { top: number; bottom: number }, windowHeight: number): boolean {
  return row.bottom <= UNDER_THE_BAR || row.top >= windowHeight;
}

/** A cat picked in the Office: whose. Made anew at every pick, so the same cat picked again is a pick again. */
export interface Picked {
  agentId: string;
}

export function AgentRows({
  rows,
  orchestrator,
  looks,
  open,
  onOpen,
  picked,
}: {
  rows: AgentRow[];
  orchestrator: string | null;
  looks: Map<string, Look>;
  open: string | null;
  onOpen: (agentId: string | null) => void;
  /** The cat last picked in the Office above: its row is brought into view when none of it is on the screen. */
  picked?: Picked | null;
}) {
  const lines = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    const row = picked ? lines.current.get(picked.agentId) : undefined;
    if (row && outOfView(row.getBoundingClientRect(), window.innerHeight)) row.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [picked]);
  return (
    <ul className="divide-y divide-base-content/[0.06] overflow-hidden rounded-2xl border border-base-content/[0.08] bg-base-100 shadow-xs" data-agent-rows>
      {rows.map(({ agent, platforms }) => {
        const name = agent.displayName || agent.id;
        const look = looks.get(agent.id);
        const isOpen = open === agent.id;
        return (
          <li
            key={agent.id}
            ref={(at) => {
              if (at) lines.current.set(agent.id, at);
              else lines.current.delete(agent.id);
            }}
            data-agent-row={agent.id}
            className={cn("scroll-mt-20", isOpen && "bg-secondary/[0.04]")}
          >
            {/* The line itself is the button, read as what it shows: a name of its own would hide the agent's state. */}
            <button
              type="button"
              className="group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left sm:px-4"
              aria-expanded={isOpen}
              title={agent.headline ? `${name}: ${agent.headline}` : name}
              onClick={() => onOpen(isOpen ? null : agent.id)}
            >
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
                <ChevronDown size={16} className={cn("shrink-0 text-base-content/50 transition-transform group-hover:text-primary", isOpen && "rotate-180")} aria-hidden="true" />
            </button>
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
