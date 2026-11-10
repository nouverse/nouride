/**
 * Groups: the conversations agents are in on chat apps, one row per group however many of our bots sit in it, and the
 * rooms made in the dashboard (which stay in Chats too), newest first. A chip per app there is a group on, and one for
 * the dashboard's rooms, narrows the list; one quiet for two weeks or more waits in one row at the end that opens them.
 */

import { useState } from "react";
import { Archive, UsersRound } from "lucide-react";
import { ConversationRow, ListHeading } from "@/commons/components/chat/ConversationRow";
import { FilterChips } from "@/commons/components/ui/FilterChips";
import { EmptyState } from "@/commons/components/ui/ui";
import { platformName } from "@/commons/lib/platform";
import type { ChatListData } from "../hooks/use-chat-list";
import type { SeenMarks } from "../hooks/use-seen";
import { DASHBOARD, groupsView, type GroupsRow } from "../lib/chat-list";
import { ChatsRow, groupName } from "./ListRows";

/** What the quiet row calls what it folds: groups, rooms, or both. */
function quietWords(rows: GroupsRow[]): string {
  const rooms = rows.filter((row) => row.kind === "room").length;
  const kind = rooms === 0 ? "group" : rooms === rows.length ? "room" : "chat";
  return rows.length === 1 ? `1 quiet ${kind}` : `${rows.length} quiet ${kind}s`;
}

export function GroupsTab({ data, query, openRow, seen }: { data: ChatListData; query: string; openRow: string | undefined; seen: SeenMarks }) {
  const [platform, setPlatform] = useState("all");
  const [quietOpen, setQuietOpen] = useState(false);
  const groups = data.list.data?.groups ?? [];
  const rooms = data.list.data?.rooms ?? [];
  if (groups.length === 0 && rooms.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title="No groups yet"
        description="When an agent talks in a group on Telegram, Discord or WhatsApp, the group shows here. You read it here, and answer on its app."
      />
    );
  }
  // Only chips the list still holds: one whose rows are gone falls back to all of them.
  const held = platform === "all" || (platform === DASHBOARD ? rooms.length > 0 : groups.some((group) => group.platform === platform));
  const chosen = held ? platform : "all";
  const view = groupsView(groups, rooms, { platform: chosen, query, now: Date.now(), nameOf: data.nameOf, platformName });
  const row = (entry: GroupsRow) => {
    const open = entry.key === openRow;
    const last = entry.kind === "group" ? entry.group.last : entry.room.last;
    return <ChatsRow key={entry.key} row={entry} data={data} current={open} unread={!open && seen.unread(entry.key, entry.at, last?.from === "agent")} />;
  };

  return (
    <div className="flex flex-col gap-0.5">
      {view.chips.length > 2 ? (
        <div className="px-1 pt-1 pb-2">
          <FilterChips label="Which app, or the dashboard's rooms" chips={view.chips} value={chosen} onChange={setPlatform} />
        </div>
      ) : null}
      {view.active.length === 0 && view.quiet.length === 0 ? <p className="px-3 py-8 text-center text-sm text-base-content/65">Nothing matches “{query.trim()}”.</p> : null}
      {view.active.map(row)}
      {view.quiet.length > 0 ? (
        <>
          <ListHeading>Quiet for two weeks or more</ListHeading>
          <ConversationRow
            onToggle={{ expanded: quietOpen, toggle: () => setQuietOpen((was) => !was) }}
            avatar={
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-base-200 text-base-content/65">
                <Archive size={18} />
              </span>
            }
            name={quietWords(view.quiet)}
            line={view.quiet.map((entry) => (entry.kind === "group" ? groupName(entry.group) : entry.room.title || entry.room.members.map(data.nameOf).join(", "))).join(", ")}
            tone="quiet"
          />
          {quietOpen ? view.quiet.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
