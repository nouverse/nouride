/**
 * Which conversation a client means by the session id it holds.
 *
 * The session row first. A conversation whose first turn is still running has none — `SessionStore.save` writes it
 * when that turn ends — but it has a turn record from the moment the turn began, and the record names the chat.
 * Without that, a message sent during the first turn of a new conversation — the one that steers it — was taken for
 * the start of another chat: the dashboard jumped to an empty conversation, and the turn it was meant for never saw it.
 */

import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";

export function conversationNamed(
  deps: { sessions?: SessionsPort; turns?: TurnsPort },
  sessionId: string,
): { agentId: string; chatId: string; gatewayId: string } | null {
  const session = deps.sessions?.find(sessionId);
  if (session) return session;
  const turn = deps.turns?.latestForSession(sessionId);
  return turn ? { agentId: turn.agentId, chatId: turn.chatId, gatewayId: turn.gatewayId } : null;
}
