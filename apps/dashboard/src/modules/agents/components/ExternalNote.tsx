/**
 * A line at the top of an agent's tab saying what of it a coding CLI uses (0.8.1). An external agent has the tabs every
 * agent has, and some of what they set does not reach its CLI: a person could not tell which, and read the Model
 * tab's fallbacks as a way past the CLI's limit. Shown only for an external agent.
 */

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "@/commons/lib/api";

/** What the note says for this agent's CLI — `skills`: whether Nouride's skills reach it; null: nothing to say. */
type Says = (agent: { name: string; cli: string; skills: boolean }) => string | null;

export function ExternalNote({ agentId, says }: { agentId: string; says: Says }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agent = status.data?.agents.find((entry) => entry.id === agentId);
  const text = agent?.external ? says({ name: agent.displayName, cli: agent.external.name ?? agent.external.cli, skills: agent.external.skills === true }) : null;
  if (!text) return null;
  return (
    <div className="alert bg-info/10 border border-info/30 text-base-content/80 rounded-xl p-3 text-sm">
      <Info size={16} className="text-info shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
