/**
 * The agents an automation's page offers, the orchestrator first: each with its name and its face as the Office draws
 * it, since who a step is given to is picked by face. And what any agent is called here, by its id.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { looksOf } from "@/commons/cat/look";
import { useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { api } from "@/commons/lib/api";
import type { AgentChoice } from "../components/KindFields";

export function useAgentChoices(): { agents: AgentChoice[]; agentName: (id: string) => string } {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const looks = useMemo(() => looksOf(status.data?.agents ?? []), [status.data?.agents]);
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (agent) => agent.id).map((agent) => ({ id: agent.id, name: agent.displayName || agent.id, look: looks.get(agent.id) }));
  return { agents, agentName: (id) => agents.find((agent) => agent.id === id)?.name ?? id };
}
