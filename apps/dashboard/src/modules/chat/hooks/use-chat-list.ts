/**
 * The list beside the chat, and the agents it is drawn with: `/chat-list` for what was said where, `/status` for each
 * agent's name and state, and each agent's cat as the Office works it out.
 *
 * Asked again every few seconds, faster while anything works, so a reply that lands in a conversation not on screen
 * moves its row up and marks it, and a group that just heard something says so.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentSummary, ChatListPayload } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { looksOf } from "@/commons/cat/look";
import type { Face } from "@/commons/components/chat/Avatars";
import { useWhose } from "./use-whose";

const BUSY_MS = 2_000;
const IDLE_MS = 5_000;

const working = (list: ChatListPayload | undefined) =>
  Boolean(list && (list.agents.some((agent) => agent.working) || list.rooms.some((room) => room.working) || list.groups.some((group) => group.working)));

export function useChatList() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const { whose } = useWhose();
  const list = useQuery({
    queryKey: ["chat-list", whose],
    queryFn: () => api.chatList(whose),
    retry: false,
    refetchInterval: (query) => (working(query.state.data) ? BUSY_MS : IDLE_MS),
  });
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
  return { status, list, agents, orchestrator, looks, byId, nameOf, faceOf, faces, whose };
}

export type ChatListData = ReturnType<typeof useChatList>;
