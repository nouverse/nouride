/**
 * The lists a conversation is a row of (the chat list, an agent's History, the rooms) asked to catch up now rather than
 * at their next tick: a conversation just started has a row at once, and one just deleted has none.
 */

import type { QueryClient } from "@tanstack/react-query";

export function refreshChatLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["chat-list"] });
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  void queryClient.invalidateQueries({ queryKey: ["rooms"] });
}
