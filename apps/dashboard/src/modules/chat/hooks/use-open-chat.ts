/**
 * Deleting the conversation open on the Chats page: the room when one is open, else the conversation. It refreshes the
 * list beside the chat, and leaves the page, since what was deleted was on screen.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { refreshChatLists } from "@/commons/lib/chat-lists";
import { useToast } from "@/commons/components/ui/toast";

export interface OpenChat {
  /** Deletes what is on screen: the room when one is open, else the conversation. Nothing on a new chat. */
  deleteOnScreen: () => void;
  deleting: boolean;
}

export function useOpenChat(input: { sessionId?: string; roomChatId?: string; onLeave: () => void }): OpenChat {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { sessionId, roomChatId, onLeave } = input;

  const removeSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      refreshChatLists(queryClient);
      onLeave();
    },
    onError: (error: unknown) => toast.error("Could not delete the conversation", error),
  });

  /** A room takes its transcript, its events, its messages and every member's conversation in it. */
  const removeRoom = useMutation({
    mutationFn: (chatId: string) => api.deleteRoom(chatId),
    onSuccess: (result) => {
      refreshChatLists(queryClient);
      toast.success("Room deleted", `${result.turns} answer(s) and every member's conversation here went with it.`);
      onLeave();
    },
    onError: (error: unknown) => toast.error("Could not delete the room", error),
  });

  return {
    deleteOnScreen: () => {
      if (roomChatId) removeRoom.mutate(roomChatId);
      else if (sessionId) removeSession.mutate(sessionId);
    },
    deleting: removeSession.isPending || removeRoom.isPending,
  };
}
