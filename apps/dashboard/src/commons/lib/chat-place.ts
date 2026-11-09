/**
 * Where the chat page is, for the shell around it: on Chats at all, where the side menu folds to icons.
 */

export function onChats(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}
