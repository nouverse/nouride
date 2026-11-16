/**
 * The agents as a list of rows under the Office: each agent a line (its cat, its name, what it is doing, what answers
 * it, where it is reached). A press anywhere on the line opens a part under it with what a person does with that agent,
 * its page first (Details). And the card of the cat picked in the Office, which holds the same line and the same part.
 *
 * They were cards, two across and five lines tall, so seven agents ran past the window and the page under the Office
 * would have been all scroll. A row is one line; opened, it shows the agent's actions in the one place they are.
 *
 * A row was two things to press: the line went to the agent's page and a small arrow at its end opened the part under
 * it, so a press meant for one took the other. A row is one press now.
 *
 * A cat picked in the Office opened its row, down in the list, and the page was moved to bring that row into view:
 * a person who pressed a cat saw the page leave under their hand. What a cat's press opens is shown where the press
 * was, in a card right under the Office and over the list (`PickedAgent`), and nothing moves the page.
 *
 * On a phone neither: a press on a cat or on a row opens the agent's card as a sheet from the foot of the screen
 * (`AgentSheet`), as every panel a phone draws over the page is, closed by its button, a swipe down, Escape or the shade.
 */

import { ChevronDown, Crown, KeyRound, Radio, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet } from "@/commons/components/ui/Sheet";
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

/** An agent in one line: its cat, its name, what answers it, where it is reached, why it cannot answer, and its state. */
function AgentLine({ agent, platforms, look, orchestrator }: AgentRow & { look: Look | undefined; orchestrator: string | null }) {
  const name = agent.displayName || agent.id;
  return (
    <>
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
    </>
  );
}

export function AgentRows({
  rows,
  orchestrator,
  looks,
  open,
  onOpen,
  sheet = false,
}: {
  rows: AgentRow[];
  orchestrator: string | null;
  looks: Map<string, Look>;
  open: string | null;
  onOpen: (agentId: string | null) => void;
  /** A press opens the agent's sheet (a phone), not a part under the row. */
  sheet?: boolean;
}) {
  return (
    <ul className="divide-y divide-base-content/[0.06] overflow-hidden rounded-2xl border border-base-content/[0.08] bg-base-100 shadow-xs" data-agent-rows>
      {rows.map(({ agent, platforms }) => {
        const name = agent.displayName || agent.id;
        const isOpen = open === agent.id;
        return (
          <li key={agent.id} data-agent-row={agent.id} className={cn(isOpen && "bg-secondary/[0.04]")}>
            {/* The line itself is the button, read as what it shows: a name of its own would hide the agent's state. */}
            <button
              type="button"
              className="group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left sm:px-4"
              {...(sheet ? { "aria-haspopup": "dialog" as const } : { "aria-expanded": isOpen })}
              title={agent.headline ? `${name}: ${agent.headline}` : name}
              onClick={() => onOpen(isOpen ? null : agent.id)}
            >
              <AgentLine agent={agent} platforms={platforms} look={looks.get(agent.id)} orchestrator={orchestrator} />
              <ChevronDown size={16} className={cn("shrink-0 text-base-content/50 transition-transform group-hover:text-primary", sheet ? "-rotate-90" : isOpen && "rotate-180")} aria-hidden="true" />
            </button>
            {isOpen && !sheet ? (
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

/**
 * The cat picked in the Office, as a card right under it and over the list: the agent's line, what it is doing and what
 * a person does with it. Closed by its own button, by its cat pressed again, or by another cat picked in its place.
 */
export function PickedAgent({ row, orchestrator, look, onClose }: { row: AgentRow; orchestrator: string | null; look: Look | undefined; onClose: () => void }) {
  const { agent, platforms } = row;
  const name = agent.displayName || agent.id;
  return (
    <section data-agent-picked={agent.id} aria-label={`${name}, picked in the office`} className="animate-fade rounded-2xl border border-secondary/30 bg-base-100 shadow-xs">
      <div className="flex items-center gap-1 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 sm:px-4" title={agent.headline ? `${name}: ${agent.headline}` : name}>
          <AgentLine agent={agent} platforms={platforms} look={look} orchestrator={orchestrator} />
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-circle shrink-0" aria-label={`Close ${name}`} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="px-3 pb-3 sm:px-4 sm:pl-[4.25rem]">
        <AgentActions agent={agent} status={statusOf(agent)} />
      </div>
    </section>
  );
}

/**
 * An agent's card on a phone: the line and what a person does with it, in a sheet named for the agent. The agent stays
 * drawn while the sheet slides away, so it is not emptied on its way down.
 */
export function AgentSheet({ row, orchestrator, look, onClose }: { row: AgentRow | undefined; orchestrator: string | null; look: Look | undefined; onClose: () => void }) {
  const [shown, setShown] = useState(row);
  useEffect(() => {
    if (row) setShown(row);
  }, [row]);
  const name = shown ? shown.agent.displayName || shown.agent.id : "";
  return (
    <Sheet open={row !== undefined} onClose={onClose} label={name || "Agent"} title={name} closeLabel={`Close ${name}`}>
      {shown ? (
        <div data-agent-sheet={shown.agent.id} className="space-y-3 overflow-y-auto overscroll-contain px-4 pt-1 pb-4">
          <div className="flex min-w-0 items-center gap-3" title={shown.agent.headline ? `${name}: ${shown.agent.headline}` : name}>
            <AgentLine agent={shown.agent} platforms={shown.platforms} look={look} orchestrator={orchestrator} />
          </div>
          <AgentActions agent={shown.agent} status={statusOf(shown.agent)} />
        </div>
      ) : null}
    </Sheet>
  );
}
