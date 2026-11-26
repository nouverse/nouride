/**
 * Which agents are open to everyone, and where: said on the page that answers "who may talk to my agents".
 *
 * Whoever writes to such an agent is in none of this page's lists: they were never asked for a code, so nobody was
 * approved. Without this line the page would say "only those approved are answered" beside a bot that answers anyone.
 * Each agent's name opens its own list on the Open agents page. Nothing is drawn where no agent is open.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import type { AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { connectionSaid } from "@/commons/lib/platform";

/** Where one open agent is reached, in a few words. */
export function openOn(agent: Pick<AgentSummary, "open">): string {
  const connections = agent.open?.connections ?? [];
  return connections.length === 0 ? "with no connection of its own yet" : `on ${connections.map(connectionSaid).join(", ")}`;
}

export function OpenAgents() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const open = (status.data?.agents ?? []).filter((agent) => agent.access === "open");
  if (open.length === 0) return null;
  return (
    <p className="text-base-content/65 text-sm flex items-start gap-2" data-open-agents>
      <Globe size={14} className="text-primary mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        Open to everyone, with no code:{" "}
        {open.map((agent, index) => (
          <span key={agent.id}>
            {index > 0 ? "; " : ""}
            <Link to="/open-agents" search={{ agent: agent.id }} className="link link-primary">
              {agent.displayName || agent.id}
            </Link>{" "}
            {openOn(agent)}
          </span>
        ))}
        . Who writes to {open.length === 1 ? "it is not in these lists: it has" : "them is not in these lists: each has"} a list of its own on{" "}
        <Link to="/open-agents" className="link link-primary">
          Open agents
        </Link>
        .
      </span>
    </p>
  );
}
