/**
 * What the open conversation needs beyond its turns: the room it is, when it is one, and deleting it.
 *
 * The room is fetched by id rather than read out of the transcript, because the header has to be right before anybody
 * has spoken: a room created a second ago has no turns and no sessions, and its name and members are all there is.
 * Deleting refreshes the list beside the chat, and leaves the page when what was deleted was on screen.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { Room } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";

export interface OpenChat {
  /** The open room, or null — including a room nobody has spoken in, which has no session yet. */
  room: Room | null;
  /** Deletes what is on screen: the room when one is open, else the conversation. Nothing on a new chat. */
  deleteOnScreen: () => void;
  deleting: boolean;
  /** Asks the list and the History to catch up now rather than at their next tick: a new chat has a row at once. */
  refresh: () => void;
}

export function useOpenChat(input: { sessionId?: string; roomChatId?: string; onLeave: () => void }): OpenChat {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { sessionId, roomChatId, onLeave } = input;

  const roomQuery = useQuery({
    queryKey: ["rooms", roomChatId],
    queryFn: () => api.room(roomChatId!),
    enabled: Boolean(roomChatId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["chat-list"] });
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
  };

  const removeSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      refresh();
      onLeave();
    },
    onError: (error: unknown) => toast.error("Could not delete the conversation", error),
  });

  /** A room takes its transcript, its events, its messages and every member's conversation in it. */
  const removeRoom = useMutation({
    mutationFn: (chatId: string) => api.deleteRoom(chatId),
    onSuccess: (result) => {
      refresh();
      toast.success("Room deleted", `${result.turns} answer(s) and every member's conversation here went with it.`);
      onLeave();
    },
    onError: (error: unknown) => toast.error("Could not delete the room", error),
  });

  return {
    room: roomQuery.data?.room ?? null,
    deleteOnScreen: () => {
      if (roomChatId) removeRoom.mutate(roomChatId);
      else if (sessionId) removeSession.mutate(sessionId);
    },
    deleting: removeSession.isPending || removeRoom.isPending,
    refresh,
  };
}
