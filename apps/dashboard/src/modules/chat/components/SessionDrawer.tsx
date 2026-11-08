/**
 * The conversation list.
 *
 * Three things it could not do before: say which conversation is *working* (the daemon now reports
 * that per session, so it is true even for a turn started on Telegram), say what a conversation was
 * about (its first question, rather than `web-1757003921`), and delete one.
 *
 * And three more, added when the list outgrew the screen. It was a flat hundred rows, newest first,
 * with no way to ask for the hundred-and-first and no way to find anything in them — the badge said
 * `100` whether the daemon held a hundred conversations or nine hundred, which is the kind of number
 * that reads as a fact and is not one. Now it searches, it groups by when, and it pages.
 *
 * The grouping is by date rather than by anything the operator maintains, which is the same choice
 * every chat history worth using makes: a folder is a thing you have to keep tidy, and "yesterday" is
 * a thing that is true without anybody doing any work.
 */

import { useState } from "react";
import { Loader2, MessageSquare, Search, Trash2, Users, X } from "lucide-react";
import type { Room, SessionSummary } from "@nouride/wire";
import { ListLoading } from "@/commons/components/ui/Spinner";

export function SessionDrawer({
  open,
  sessions,
  total,
  activeId,
  search,
  onSearch,
  loading,
  hasMore,
  onLoadMore,
  loadingMore,
  onClose,
  onSelect,
  onDelete,
  deleting,
  rooms,
  activeRoom,
  onSelectRoom,
  onDeleteRoom,
}: {
  open: boolean;
  sessions: SessionSummary[];
  /**
   * Rooms, listed above the conversations rather than mixed into the date groups.
   *
   * A room is a place you go back to, not an exchange that happened on a Tuesday — the same reason
   * a chat app pins its groups above its history. Mixing them in would also mean a room's position
   * jumping around as its members take turns.
   */
  rooms?: Room[];
  activeRoom?: string;
  onSelectRoom?: (room: Room) => void;
  /**
   * Absent means a room cannot be deleted from here.
   *
   * Optional for the same reason `onSelectRoom` is: a caller that has no rooms passes neither, and
   * the row then renders without the affordance rather than with a dead one.
   */
  onDeleteRoom?: (room: Room) => void;
  /** Every conversation the daemon holds, not just the ones on screen. */
  total: number;
  activeId?: string;
  search: string;
  onSearch: (value: string) => void;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore: () => void;
  loadingMore?: boolean;
  onClose: () => void;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  deleting?: string;
}) {
  /**
   * Which row is asking to be confirmed.
   *
   * Two clicks, not a modal: deleting a conversation destroys a transcript and cancels whatever is
   * running in it, and one misplaced click on a hover-only icon is how that happens by accident.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * One conversation row, with the drawer's own delete state around it.
   *
   * A closure rather than another six props threaded through the group loop — the confirmation is
   * per row and lives here, and the loop now renders two kinds of thing.
   */
  const SessionEntry = ({ session }: { session: SessionSummary }) => (
    <SessionRow
      session={session}
      active={activeId === session.id}
      asking={confirming === session.id}
      deleting={deleting === session.id}
      onSelect={() => onSelect(session)}
      onAsk={() => setConfirming(session.id)}
      onCancelAsk={() => setConfirming(null)}
      onConfirm={() => {
        setConfirming(null);
        onDelete(session);
      }}
    />
  );

  /**
   * The same two-step delete for a room, keyed by its chat id.
   *
   * One `confirming` and one `deleting` across both kinds, because only one row can be asking at a
   * time — a session id and a chat id never collide, so they share the state without a discriminator.
   */
  const RoomEntry = ({ room }: { room: Room }) => (
    <RoomRow
      room={room}
      active={activeRoom === room.chatId}
      asking={confirming === room.chatId}
      deleting={deleting === room.chatId}
      onSelect={() => onSelectRoom?.(room)}
      onAsk={() => setConfirming(room.chatId)}
      onCancelAsk={() => setConfirming(null)}
      onConfirm={() => {
        setConfirming(null);
        onDeleteRoom?.(room);
      }}
    />
  );

  /**
   * A room's member sessions are hidden from the conversation list.
   *
   * Each agent in a room gets its own session, so a three-agent room would otherwise appear as three
   * history rows *plus* the room itself — four entries for one conversation, three of which open the
   * same transcript. The room row is the one that means something.
   */
  const roomChats = new Set((rooms ?? []).map((room) => room.chatId));
  const groups = groupByDate(
    sessions.filter((session) => !roomChats.has(session.chatId)),
    search.trim() ? [] : (rooms ?? []),
  );

  return (
    <aside
      className={`absolute inset-y-0 left-0 z-30 w-72 bg-base-100/95 backdrop-blur-2xl border-r border-base-content/[0.08] shadow-xl flex flex-col transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="p-3 border-b border-base-content/[0.08] space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-base-content/65 px-1 font-mono">
            Chat History
            {total > 0 && (
              <span className="ml-1.5 font-mono font-medium text-base-content/65">{total}</span>
            )}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square text-base-content/65 hover:text-base-content"
            onClick={onClose}
            aria-label="Close history"
          >
            <X size={15} />
          </button>
        </div>

        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/35 pointer-events-none"
          />
          <input
            className="input input-sm w-full rounded-xl pl-7 pr-7 text-xs"
            placeholder="Search by title…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            // Escape clears rather than closes: the drawer is where you are, and losing the whole
            // panel because a search came up empty is a keystroke people learn to fear.
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.preventDefault();
                onSearch("");
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle size-5 max-sm:size-7 min-h-0 text-base-content/65 hover:text-base-content"
              onClick={() => onSearch("")}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading ? (
          <ListLoading count={4} />
        ) : sessions.length === 0 ? (
          <div className="text-center py-10 px-4 text-xs text-base-content/65">
            {search ? (
              <>
                Nothing matches <b className="text-base-content/65">{search}</b>.
                <br />
                Only the opening question of each conversation is searched.
              </>
            ) : (
              "No recorded chat sessions yet."
            )}
          </div>
        ) : (
          <>
            {groups.map((group) => (
            <div key={group.label} className="pt-1">
              {/* Sticky, so the heading still says which stretch of time you are looking at after a
                  few hundred pixels of scrolling. */}
              <p className="sticky top-0 z-10 bg-base-100/95 backdrop-blur-sm px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.entries.map((entry) =>
                  entry.kind === "room" ? (
                    <RoomEntry key={entry.room.chatId} room={entry.room} />
                  ) : (
                    <SessionEntry key={entry.session.id} session={entry.session} />
                  ),
                )}

              </div>
            </div>
            ))}
          </>
        )}

        {hasMore && (
          <button
            type="button"
            className="btn btn-ghost btn-xs w-full rounded-xl text-[11px] font-medium text-base-content/65 hover:text-base-content mt-1"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
            Load older conversations
          </button>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  asking,
  deleting,
  onSelect,
  onAsk,
  onCancelAsk,
  onConfirm,
}: {
  session: SessionSummary;
  active: boolean;
  asking: boolean;
  deleting: boolean;
  onSelect: () => void;
  onAsk: () => void;
  onCancelAsk: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className={`group w-full rounded-xl text-xs transition-all flex items-start gap-2 p-3 ${
        active
          ? "bg-primary/10 text-primary font-semibold border border-primary/20 shadow-xs"
          : "text-base-content/75 hover:bg-base-200/70 hover:text-base-content"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-start gap-2.5 min-w-0 flex-1 text-left"
      >
        {session.running ? (
          // The spinner is the daemon's answer, not a guess from this tab's own state — so a turn
          // somebody else started shows here too.
          <Loader2 size={14} className="shrink-0 mt-0.5 animate-spin text-primary" />
        ) : (
          <MessageSquare size={14} className="shrink-0 mt-0.5 opacity-60" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{session.title ?? session.chatId}</p>
          <div className="flex items-center gap-1.5 text-[10px] text-base-content/65 mt-0.5 font-mono">
            <span>{session.agentId}</span>
            <span>·</span>
            {/* Which surface it happened on. A Discord conversation is readable here and answered
                there, and the label is what makes that legible before you try. */}
            <span className="truncate">{session.gatewayId}</span>
            <span>·</span>
            <span>{clockOf(session.updatedAt)}</span>
          </div>
        </div>
      </button>

      {asking ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="btn btn-error btn-xs h-6 max-sm:h-8 px-2 rounded-lg text-[10px]"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? "…" : "Delete"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs h-6 max-sm:h-8 px-1.5 rounded-lg text-[10px]"
            onClick={onCancelAsk}
          >
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Delete this conversation"
          aria-label="Delete this conversation"
          className="btn btn-ghost btn-xs btn-square shrink-0 sm:opacity-0 sm:group-hover:opacity-100 text-base-content/65 hover:text-error transition-opacity"
          onClick={onAsk}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The time on a row.
 *
 * Only a clock for today: `05:47 PM` on a conversation from March says something false at a glance,
 * and the heading above it already says which day it was.
 */
function clockOf(at: number): string {
  const when = new Date(at);
  const sameDay = new Date().toDateString() === when.toDateString();
  return sameDay
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * One row of the history: a one-to-one conversation, or a room.
 *
 * Merged rather than pinned above. Rooms started in their own section, which put a room used a week
 * ago above a chat from a minute ago and made the list two orderings pretending to be one. What a
 * reader wants from this panel is "what was I doing recently", and that question does not care which
 * kind of conversation the answer is — so the kind is shown on the row instead.
 */
export type HistoryEntry =
  | { kind: "session"; at: number; session: SessionSummary }
  | { kind: "room"; at: number; room: Room };

export interface SessionGroup {
  label: string;
  entries: HistoryEntry[];
}

/**
 * Conversations under the stretch of time they belong to.
 *
 * Boundaries are *calendar* ones, not "24 hours ago": something from 11pm last night is yesterday at
 * 8am, not today, and a list that says otherwise is arguing with the reader. The rows are already
 * newest-first from the daemon, so this only has to walk them once and cut where the label changes —
 * which also means it cannot reorder anything.
 */
export function groupByDate(
  sessions: SessionSummary[],
  rooms: Room[] = [],
  now = Date.now(),
): SessionGroup[] {
  const entries: HistoryEntry[] = [
    ...sessions.map((session) => ({ kind: "session" as const, at: session.updatedAt, session })),
    ...rooms.map((room) => ({
      kind: "room" as const,
      // A room nobody has spoken in has only its creation to go on.
      at: room.updatedAt ?? room.createdAt,
      room,
    })),
  ];
  // Sorted here rather than trusted from the server: the two lists arrive from different endpoints
  // and are each ordered, which is not the same as being ordered together.
  entries.sort((a, b) => b.at - a.at);

  const groups: SessionGroup[] = [];
  for (const entry of entries) {
    const label = labelFor(entry.at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function labelFor(at: number, now: number): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - startOfDay(at)) / 86_400_000);

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

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * A room in the history list.
 *
 * Distinguished by its icon and a `room` tag rather than by position: the panel answers "what was I
 * doing recently", and that question does not care which kind of conversation the answer is. A
 * separate pinned section put a room used a week ago above a chat from a minute ago.
 *
 * The member handles are shown even when the room has a name, because those are the tokens a person
 * has to type to reach somebody in it.
 */
function RoomRow({
  room,
  active,
  asking,
  deleting,
  onSelect,
  onAsk,
  onCancelAsk,
  onConfirm,
}: {
  room: Room;
  active: boolean;
  asking: boolean;
  deleting: boolean;
  onSelect: () => void;
  onAsk: () => void;
  onCancelAsk: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className={`group flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-all ${
        active ? "bg-primary/10 text-primary" : "hover:bg-base-200/60 text-base-content/85"
      }`}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-start gap-2 text-left">
        {room.running ? (
          /**
           * The same spinner a one-to-one conversation gets, for the same reason and from the same
           * source — the daemon's own answer, so a turn somebody else started shows here too.
           *
           * A room could not report this at all until `/rooms` grew a `running` field: its turns
           * belong to its members' sessions, and this list hides those so a three-agent room is one
           * entry rather than four. So a working DM span and a working room showed nothing, which
           * reads as the room having finished.
           */
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Users size={14} className="mt-0.5 shrink-0 opacity-60" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-semibold">
              {room.title ?? room.members.map((member) => member.agentId).join(", ")}
            </span>
            <span className="shrink-0 rounded bg-base-content/[0.07] px-1 text-[9px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
              room
            </span>
          </span>
          <span className="block truncate font-mono text-[10px] text-base-content/65">
            {room.members.map((member) => `@${member.agentId}`).join(" ")}
          </span>
        </span>
      </button>

      {/*
        The same two-step delete a conversation gets, and it matters more here: deleting a room takes
        its transcript, its events, its messages and its file list with it, and the icon only appears
        on hover — one misplaced click is how that happens by accident.
      */}
      {asking ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn btn-error btn-xs h-6 max-sm:h-8 rounded-lg px-2 text-[10px]"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? "…" : "Delete"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs h-6 max-sm:h-8 rounded-lg px-1.5 text-[10px]"
            onClick={onCancelAsk}
          >
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Delete this room"
          aria-label="Delete this room"
          className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/65 opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
          onClick={onAsk}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}
