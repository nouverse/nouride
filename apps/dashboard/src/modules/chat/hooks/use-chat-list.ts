/**
 * The list beside the chat, and the agents it is drawn with: `/chat-list` for what was said where, and the agents as
 * every chat reads them (`useChatAgents`): each one's name and state, and its cat as the Office works it out.
 *
 * Asked again every few seconds, faster while anything works, so a reply that lands in a conversation not on screen
 * moves its row up and marks it, and a group that just heard something says so.
 */

import { useQuery } from "@tanstack/react-query";
import type { ChatListPayload } from "@nouride/wire";
import { useChatAgents } from "@/commons/hooks/use-chat-agents";
import { useWhose } from "@/commons/hooks/use-whose";
import { api } from "@/commons/lib/api";

const BUSY_MS = 2_000;
const IDLE_MS = 5_000;

const working = (list: ChatListPayload | undefined) =>
  Boolean(list && (list.agents.some((agent) => agent.working) || list.rooms.some((room) => room.working) || list.groups.some((group) => group.working)));

export function useChatList() {
  const agents = useChatAgents();
  const { whose } = useWhose("chat");
  const list = useQuery({
    queryKey: ["chat-list", whose],
    queryFn: () => api.chatList(whose),
    retry: false,
    refetchInterval: (query) => (working(query.state.data) ? BUSY_MS : IDLE_MS),
  });
  return { ...agents, list, whose };
}

export type ChatListData = ReturnType<typeof useChatList>;
