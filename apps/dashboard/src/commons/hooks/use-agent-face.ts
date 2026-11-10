/**
 * An agent's face wherever its words are drawn: its name, the cat it wears in the Office, and its colour, one of its own
 * (`agent-tints.ts`). From `/status`, the query every page around it already reads.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { looksOf, type Look } from "@/commons/cat/look";
import { agentTints } from "@/commons/lib/agent-tints";
import { api } from "@/commons/lib/api";

export interface AgentFace {
  name: string;
  /** Absent for an agent the daemon no longer has. */
  look?: Look;
  /** Its colour, for its name, its tag and the orchestrator's ring: its own, no other agent's (`agentTints`). */
  tint?: string;
  /** The orchestrator (`[daemon] orchestrator`): the one agent whose cat is ringed, as the mockup the owner signed off marks it. */
  orchestrator?: boolean;
}

export function useAgentFace(agentId: string | undefined): AgentFace | null {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agents = status.data?.agents;
  const looks = useMemo(() => looksOf(agents ?? []), [agents]);
  const tints = useMemo(
    () => agentTints([...looks].map(([id, look]) => ({ id, look })), status.data?.orchestrator),
    [looks, status.data?.orchestrator],
  );
  if (!agentId) return null;
  const name = agents?.find((agent) => agent.id === agentId)?.displayName || agentId;
  const look = looks.get(agentId);
  const orchestrator = status.data?.orchestrator === agentId ? { orchestrator: true } : {};
  if (!look) return { name, ...orchestrator };
  return { name, look, tint: tints.get(agentId)!, ...orchestrator };
}
