/**
 * The chats the daemon knows, and what each is — read once per page (`GET /chats`), shared by the forms that pick where
 * a job's results go and the cards that say where they went.
 */

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { chatLabel } from "@/commons/lib/chats";

export function useKnownChats() {
  const known = useQuery({ queryKey: ["chats"], queryFn: api.chats, retry: false, staleTime: 60_000 });
  const chats = known.data?.chats ?? [];
  /** A chat's words, or undefined for one the daemon cannot name — the id alone is shown then. */
  const labelOf = useCallback(
    (gatewayId: string, chatId: string) => {
      const chat = chats.find((one) => one.gatewayId === gatewayId && one.chatId === chatId);
      return chat ? chatLabel(chat) : undefined;
    },
    [chats],
  );
  return { chats, labelOf, loading: known.isLoading };
}
