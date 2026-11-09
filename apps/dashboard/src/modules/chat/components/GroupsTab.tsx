/**
 * Groups: the conversations agents are in on chat apps, one row per group however many of our bots sit in it, newest
 * first. A chip per app there is a group on narrows the list to it; a group quiet for two weeks or more waits in one
 * row at the end that opens them.
 */

import { useState } from "react";
import { Archive, UsersRound } from "lucide-react";
import { ConversationRow, ListHeading } from "@/commons/components/chat/ConversationRow";
import { FilterChips } from "@/commons/components/ui/FilterChips";
import { EmptyState } from "@/commons/components/ui/ui";
import { platformName } from "@/commons/lib/platform";
import type { ChatListData } from "../hooks/use-chat-list";
import type { SeenMarks } from "../hooks/use-seen";
import { groupKey, groupsView } from "../lib/chat-list";
import { GroupRow, groupName, groupRowKey } from "./ListRows";

export function GroupsTab({ data, query, openGroup, seen }: { data: ChatListData; query: string; openGroup: string | undefined; seen: SeenMarks }) {
  const [platform, setPlatform] = useState("all");
  const [quietOpen, setQuietOpen] = useState(false);
  const groups = data.list.data?.groups ?? [];
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title="No groups yet"
        description="When an agent talks in a group on Telegram, Discord or WhatsApp, the group shows here. You read it here, and answer on its app."
      />
    );
  }
  // Only apps the list still holds: a chip whose groups are gone falls back to all of them.
  const chosen = platform === "all" || groups.some((group) => group.platform === platform) ? platform : "all";
  const view = groupsView(groups, { platform: chosen, query, now: Date.now(), nameOf: data.nameOf, platformName });
  const row = (group: (typeof groups)[number]) => {
    const key = groupKey(group);
    const open = key === openGroup;
    return <GroupRow key={key} group={group} data={data} current={open} unread={!open && seen.unread(groupRowKey(group), group.at, group.last?.from === "agent")} />;
  };

  return (
    <div className="flex flex-col gap-0.5">
      {view.chips.length > 2 ? (
        <div className="px-1 pt-1 pb-2">
          <FilterChips label="Which app" chips={view.chips} value={chosen} onChange={setPlatform} />
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
            name={view.quiet.length === 1 ? "1 quiet group" : `${view.quiet.length} quiet groups`}
            line={view.quiet.map(groupName).join(", ")}
            tone="quiet"
          />
          {quietOpen ? view.quiet.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
