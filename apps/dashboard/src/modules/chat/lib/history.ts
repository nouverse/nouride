/**
 * An agent's History: only that agent's conversations, the dashboard's and its private chats on chat apps, under the
 * stretch of time each belongs to.
 *
 * The grouping is by date rather than by anything a person maintains: a folder is a thing to keep tidy, and "yesterday"
 * is true without anybody doing any work. Boundaries are calendar ones, not "24 hours ago": something from 11pm last
 * night is yesterday at 8am, not today.
 */

import type { ChatListPayload, SessionSummary } from "@nouride/wire";
import { daysAgo } from "@/commons/lib/when";

export interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

function labelFor(at: number, now: number): string {
  const days = daysAgo(at, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  const when = new Date(at);
  // The year only once it stops being obvious — "March" in the same year, "March 2025" after that.
  return when.getFullYear() === new Date(now).getFullYear()
    ? when.toLocaleDateString([], { month: "long" })
    : when.toLocaleDateString([], { month: "long", year: "numeric" });
}

/** Conversations, newest first as the daemon sends them, cut where the heading changes: the order is never changed. */
export function groupByDate(sessions: readonly SessionSummary[], now = Date.now()): SessionGroup[] {
  const groups: SessionGroup[] = [];
  for (const session of sessions) {
    const label = labelFor(session.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.sessions.push(session);
    else groups.push({ label, sessions: [session] });
  }
  return groups;
}

/**
 * Of an agent's conversations, the ones its History lists: not a room's (a room is its own row in Chats, one
 * conversation with several agents) and not a group's on a chat app (Groups has those) — its own, here and in private.
 */
export function ownConversations(sessions: readonly SessionSummary[], list: ChatListPayload | undefined): SessionSummary[] {
  const rooms = new Set((list?.rooms ?? []).map((room) => room.chatId));
  const groups = new Set((list?.groups ?? []).flatMap((group) => group.sessions.map((session) => session.sessionId)));
  return sessions.filter((session) => !rooms.has(session.chatId) && !groups.has(session.id));
}
