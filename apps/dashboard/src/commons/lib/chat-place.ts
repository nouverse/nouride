/**
 * Where the chat page is, for the shell around it: on Chats at all (the side menu folds to icons there), and whether a
 * conversation is open rather than the list alone — on a phone an open conversation is the whole screen, with its own
 * way back, and the app's header and tab bar step aside.
 */

export function onChats(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}

/** A conversation, a room or a group by its address; a new chat by the agent or the draft it was opened with. */
export function chatOpen(pathname: string, searchStr: string): boolean {
  if (pathname.startsWith("/chat/")) return true;
  if (pathname !== "/chat") return false;
  const search = new URLSearchParams(searchStr);
  return search.has("agent") || search.has("draft");
}
