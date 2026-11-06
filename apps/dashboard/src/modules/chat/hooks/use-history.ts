/**
 * Everything the history sidebar reads and everything it can delete.
 *
 * One hook because these five queries are one feature: the conversation list, the room list, the
 * open room, and the two deletes that invalidate them. Left in the page they were eighty lines of
 * data-fetching in the middle of a component whose job is to draw a conversation.
 *
 * ## Why both lists poll, and why the interval moves
 *
 * A flat interval made the running spinner a lie for most of its life: a four-second turn showed one
 * for a fraction of that, and a conversation that had just finished kept it. So both lists ask
 * faster while something is running, and the answer comes from the *data* rather than from the
 * page's own state — a turn somebody started in another tab should quicken this list too.
 *
 * The rooms list did not poll at all, which is why a room could not show that an agent was working
 * in it even after the daemon began reporting it.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { Room, SessionSummary } from "@/commons/lib/api";

/** Conversations per page. A list somebody scrolls, not a report. */
const SESSION_PAGE = 50;

/** While something is running, and while nothing is. */
const BUSY_MS = 2_000;
const IDLE_MS = 5_000;
/**
 * A list scrolled past its first page is refetched whole — every page, in turn — so it is polled slower; a turn ending
 * in the open conversation refetches it at once (`lib/stream.ts`).
 */
const DEEP_BUSY_MS = 10_000;
const DEEP_IDLE_MS = 30_000;

export interface ChatHistory {
  sessions: SessionSummary[];
  /** What the daemon holds, not what is on screen — the badge used to read the page size. */
  total: number;
  /** True while the first page is still in flight, for the drawer's own skeleton. */
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  rooms: Room[];
  /** The open room, or null — including a room nobody has spoken in, which has no session yet. */
  room: Room | null;
  deleteSession: (id: string) => void;
  deleteRoom: (chatId: string) => void;
  /** The id or chat id currently being deleted, for the row's own spinner. */
  deleting: string | undefined;
  /** Asks both lists to catch up now rather than at their next tick. */
  refresh: () => void;
}

export function useChatHistory(input: {
  searchTerm: string;
  /** The conversation on screen, so deleting it can navigate away. Absent for a new chat. */
  sessionId?: string;
  roomChatId?: string;
  onLeave: () => void;
}): ChatHistory {
  const queryClient = useQueryClient();
  const { searchTerm, sessionId, roomChatId, onLeave } = input;

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: api.rooms,
    refetchInterval: (query) =>
      query.state.data?.rooms.some((room) => room.running) ? BUSY_MS : IDLE_MS,
  });

  const roomQuery = useQuery({
    queryKey: ["rooms", roomChatId],
    queryFn: () => api.room(roomChatId!),
    enabled: Boolean(roomChatId),
  });

  const sessions = useInfiniteQuery({
    /**
     * `"list"` in the key, and it is not decoration.
     *
     * The Schedule page reads the same endpoint for its chat picker, with a *plain* query. When both
     * keys were `["sessions", <term>]` they collided at the empty search term: whichever mounted
     * first filled the cache, and the infinite query then met a payload with no `pages` array and
     * threw `Cannot read properties of undefined (reading 'length')` inside `createResult`. Clicking
     * Chat after visiting Schedule crashed the page; a reload fixed it, because then nothing had put
     * the other shape in the cache. Two query types must never share one key.
     */
    queryKey: ["sessions", "list", searchTerm],
    queryFn: ({ pageParam }) =>
      api.sessions({
        limit: SESSION_PAGE,
        ...(searchTerm ? { q: searchTerm } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const running = pages.some((page) => page.sessions.some((session) => session.running));
      if (pages.length > 1) return running ? DEEP_BUSY_MS : DEEP_IDLE_MS;
      return running ? BUSY_MS : IDLE_MS;
    },
  });

  const removeSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (id === sessionId) onLeave();
    },
  });

  /**
   * Deleting a room, which takes more with it than a conversation does.
   *
   * The route drops its transcript, its events, its messages and its file list in one call — so what
   * needs invalidating afterwards is everything the sidebar reads, and the only thing to navigate is
   * away, if the room being deleted is the one on screen.
   */
  const removeRoom = useMutation({
    mutationFn: (chatId: string) => api.deleteRoom(chatId),
    onSuccess: (_result, chatId) => {
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (chatId === roomChatId) onLeave();
    },
  });

  const pages = sessions.data?.pages ?? [];

  return {
    sessions: pages.flatMap((page) => page.sessions),
    total: pages[0]?.total ?? 0,
    loading: sessions.isPending,
    hasMore: sessions.hasNextPage,
    loadingMore: sessions.isFetchingNextPage,
    loadMore: () => void sessions.fetchNextPage(),
    rooms: roomsQuery.data?.rooms ?? [],
    room: roomQuery.data?.room ?? null,
    deleteSession: (id) => removeSession.mutate(id),
    deleteRoom: (chatId) => removeRoom.mutate(chatId),
    deleting:
      (removeSession.isPending ? removeSession.variables : undefined) ??
      (removeRoom.isPending ? removeRoom.variables : undefined),
    /**
     * Called on send, so a brand-new conversation's row appears at once.
     *
     * It has no row until the daemon records a session, which happens when the turn starts — under
     * two seconds, measured. Waiting for the poll meant sending the first message of a new chat and
     * watching the history not mention it, which reads as the message having gone nowhere.
     */
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    },
  };
}
