/**
 * Where the agents open to everyone are: said on the page that answers "who may talk to my agents".
 *
 * Whoever writes to such an agent is in none of this page's lists: they were never asked for a code, so nobody was
 * approved. Without this line the page would say "only those approved are answered" beside a bot that answers anyone.
 * One line, straight to where they are; which agents they are is that page's to say. Nothing is drawn where no agent
 * is open.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { api } from "@/commons/lib/api";

export function OpenAgents() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  if (!(status.data?.agents ?? []).some((agent) => agent.access === "open")) return null;
  return (
    <p className="text-base-content/65 text-sm flex items-start gap-2" data-open-agents>
      <Globe size={14} className="text-primary mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        Agents open to everyone are not in these lists: they are on{" "}
        <Link to="/open-agents" className="link link-primary">
          Open agents
        </Link>
        .
      </span>
    </p>
  );
}
