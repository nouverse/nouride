/**
 * An agent's face wherever its words are drawn: its name, the cat it wears in the Office, and its colour — the colour of
 * that cat's outfit, made readable on either theme. From `/status`, the query every page around it already reads.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { COLORS } from "@/commons/cat/art";
import { looksOf, type Look } from "@/commons/cat/look";
import { api } from "@/commons/lib/api";

export interface AgentFace {
  name: string;
  /** Absent for an agent the daemon no longer has. */
  look?: Look;
  /**
   * Its colour, for its name and the ring round its cat: the outfit's shade drawn towards the text colour, so a white
   * or a charcoal outfit still reads on a light page and a dark one.
   */
  tint?: string;
  /** The orchestrator (`[daemon] orchestrator`): the one agent whose cat is ringed, as the mockup the owner signed off marks it. */
  orchestrator?: boolean;
}

export function useAgentFace(agentId: string | undefined): AgentFace | null {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agents = status.data?.agents;
  const looks = useMemo(() => looksOf(agents ?? []), [agents]);
  if (!agentId) return null;
  const name = agents?.find((agent) => agent.id === agentId)?.displayName || agentId;
  const look = looks.get(agentId);
  const orchestrator = status.data?.orchestrator === agentId ? { orchestrator: true } : {};
  if (!look) return { name, ...orchestrator };
  return { name, look, tint: `color-mix(in oklab, ${COLORS[look.outfitColor].q} 60%, var(--color-base-content))`, ...orchestrator };
}
