/**
 * The agents a chat is drawn with, wherever one is: each one's name and state from `/status`, which of them is the
 * orchestrator, and each one's cat as the Office works it out. The Chats page adds its list to this
 * (`modules/chat/hooks/use-chat-list.ts`); the floating chat needs no more.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { looksOf } from "@/commons/cat/look";
import type { Face } from "@/commons/components/chat/Avatars";

export function useChatAgents() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const orchestrator = status.data?.orchestrator ?? null;
  const agents = useMemo<AgentSummary[]>(() => status.data?.agents ?? [], [status.data?.agents]);
  const looks = useMemo(() => looksOf(agents), [agents]);
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const nameOf = (agentId: string) => byId.get(agentId)?.displayName || agentId;
  /** An agent's face for a stack or a row; one the daemon no longer has is left out rather than drawn as nobody. */
  const faceOf = (agentId: string): Face | null => {
    const look = looks.get(agentId);
    return look ? { id: agentId, name: nameOf(agentId), look } : null;
  };
  const faces = (ids: readonly string[]) => ids.map(faceOf).filter((face): face is Face => face !== null);
  return { status, agents, orchestrator, looks, byId, nameOf, faceOf, faces };
}

/** What a conversation reads of it: who the agents are, which answers when none is named, and each one's cat. */
export type ChatAgents = Pick<ReturnType<typeof useChatAgents>, "agents" | "orchestrator" | "looks" | "nameOf">;
