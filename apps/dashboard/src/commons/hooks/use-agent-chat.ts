/**
 * Where an agent's chat opens, wherever a person picks the agent: its newest conversation, to carry on where it was left,
 * and a new chat with it when it has none. The chat list's row and the Office's Open chat open the same one: the Office
 * once started a new chat every time, leaving the conversation the person was in behind.
 */

import { useQuery } from "@tanstack/react-query";
import type { LinkProps } from "@tanstack/react-router";
import { api } from "@/commons/lib/api";

export function agentChatLink(agentId: string, sessionId: string | undefined): LinkProps {
  return sessionId ? { to: "/chat/$sessionId", params: { sessionId } } : { to: "/chat", search: { agent: agentId } };
}

/** The same, for a page without the chat list: its newest conversation is the list's (`/chat-list`), one query for both. */
export function useAgentChatLink(agentId: string): LinkProps {
  const list = useQuery({ queryKey: ["chat-list"], queryFn: api.chatList, retry: false });
  return agentChatLink(agentId, list.data?.agents.find((entry) => entry.agentId === agentId)?.sessionId);
}
