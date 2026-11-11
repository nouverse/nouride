/**
 * Which conversation a client means by the session id it holds — and whether this reader may open it.
 *
 * The session row first. A conversation whose first turn is still running has none — `SessionStore.save` writes it
 * when that turn ends — but it has a turn record from the moment the turn began, and the record names the chat and who
 * spoke. Without that, a message sent during the first turn of a new conversation — the one that steers it — was taken
 * for the start of another chat: the dashboard jumped to an empty conversation, and the turn it was meant for never saw
 * it.
 *
 * A route that names a conversation finds it with `conversationFor`: for a reader who may not open it, it is not there
 * (`whose.ts`).
 */

import { personWhoOpened, type SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import { mayOpen, type KindSources, type Reader } from "./whose.ts";

export interface NamedConversation {
  agentId: string;
  chatId: string;
  gatewayId: string;
  /** Who opened it (`Session.openedBy`), from its first turn while it has no row. */
  openedBy?: string;
}

export function conversationNamed(deps: { sessions?: SessionsPort; turns?: TurnsPort }, sessionId: string): NamedConversation | null {
  const session = deps.sessions?.find(sessionId);
  if (session) return session;
  const turn = deps.turns?.latestForSession(sessionId);
  if (!turn) return null;
  const openedBy = personWhoOpened(turn);
  return { agentId: turn.agentId, chatId: turn.chatId, gatewayId: turn.gatewayId, ...(openedBy ? { openedBy } : {}) };
}

/** The conversation, or null when there is none or this reader may not open it — the one answer to both. */
export function conversationFor(
  deps: { sessions?: SessionsPort; turns?: TurnsPort } & KindSources,
  reader: Reader,
  sessionId: string,
): NamedConversation | null {
  const named = conversationNamed(deps, sessionId);
  return named && mayOpen(deps, reader, named) ? named : null;
}
