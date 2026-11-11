/**
 * The list beside the chat: every conversation a person can have here, and every group the agents are in elsewhere.
 *
 * Chats is what can be talked to from the dashboard — the orchestrator first, then agents and rooms by when they last
 * moved, then agents nobody has talked to yet. Groups is what agents hear on Telegram, Discord and WhatsApp, read here
 * and answered there. On a phone this is the whole screen until a conversation is opened; from a tablet's width up it
 * stays beside the conversation.
 */

import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, UsersRound } from "lucide-react";
import { ListHeading } from "@/commons/components/chat/ConversationRow";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { EmptyState } from "@/commons/components/ui/ui";
import type { ChatListData } from "../hooks/use-chat-list";
import { usePinnedGroups } from "../hooks/use-pinned";
import { useSeen } from "../hooks/use-seen";
import { chatsView, groupKey, type ChatRow } from "../lib/chat-list";
import { useWhose } from "../hooks/use-whose";
import { EveryoneList } from "./EveryoneList";
import { ChatsRow } from "./ListRows";
import { GroupsTab } from "./GroupsTab";
import { StartMenu } from "./StartMenu";

/** What is open beside the list, to mark its row and keep it read. */
export interface OpenNow {
  sessionId?: string;
  roomChatId?: string;
  /** A group's `groupKey`. */
  group?: string;
}

const rowIsOpen = (row: ChatRow, open: OpenNow) =>
  row.kind === "agent"
    ? Boolean(open.sessionId && row.entry?.sessionId === open.sessionId)
    : row.kind === "room"
      ? row.room.chatId === open.roomChatId
      : groupKey(row.group) === open.group;

/** Whether a row's newest line is an agent's: a person's own message is not something to read. */
const fromAgent = (row: ChatRow) => (row.kind === "agent" ? row.entry?.last?.from === "agent" : row.kind === "room" ? row.room.last?.from === "agent" : row.group.last?.from === "agent");

export function ChatList({ data, open, className }: { data: ChatListData; open: OpenNow; className?: string }) {
  const [tab, setTab] = useState<"chats" | "groups">(open.group ? "groups" : "chats");
  // An admin reads their own by default, and everyone's set apart by person when they pick it.
  const { whose, setWhose, canPick } = useWhose();
  const [query, setQuery] = useState("");
  const [pinnedGroups] = usePinnedGroups();
  const seen = useSeen();
  const groups = data.list.data?.groups ?? [];
  const rooms = data.list.data?.rooms ?? [];
  const view = useMemo(
    () => chatsView({ agents: data.agents, orchestrator: data.orchestrator, list: data.list.data, pinnedGroups, query, nameOf: data.nameOf }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nameOf` reads `agents`, which is here
    [data.agents, data.orchestrator, data.list.data, pinnedGroups, query],
  );

  // What is open is read: its row is marked up to its newest line, here and as that line moves.
  const openRow = [view.pinned, ...view.recent].find((row): row is ChatRow => row !== null && rowIsOpen(row, open));
  const openGroup = open.group ? groups.find((group) => groupKey(group) === open.group) : undefined;
  const { markSeen } = seen;
  const openKey = openRow?.key ?? (openGroup ? `group:${groupKey(openGroup)}` : undefined);
  const openAt = openRow?.at ?? openGroup?.at;
  useEffect(() => {
    if (openKey && openAt) markSeen(openKey, openAt);
  }, [openKey, openAt, markSeen]);

  const latestGroup = groups.reduce((latest, group) => Math.max(latest, group.at), 0);
  const { lookedAtGroups } = seen;
  useEffect(() => {
    if (tab === "groups") lookedAtGroups();
  }, [tab, latestGroup, lookedAtGroups]);

  const unread = (row: ChatRow) => !rowIsOpen(row, open) && seen.unread(row.key, row.at, fromAgent(row));
  const loading = data.status.isPending || (data.list.isPending && !data.list.isError);

  return (
    <aside aria-label="Chats" className={className}>
      <div className="flex shrink-0 flex-col gap-3 px-3 pt-4 pb-2 sm:px-4">
        <div className="flex items-center justify-between gap-2 px-1">
          <h1 className="font-display text-2xl font-medium tracking-tight text-base-content">Chats</h1>
          <StartMenu data={data} />
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={tab === "chats" ? "Search chats" : "Search groups"} className="input-md h-11 w-full sm:h-10" />
        {canPick ? (
          <SegmentedTabs
            fill
            label="Whose chats"
            value={whose}
            onChange={setWhose}
            tabs={[
              { value: "mine", label: "Mine" },
              { value: "everyone", label: "Everyone" },
            ]}
          />
        ) : null}
        <SegmentedTabs
          fill
          label="What to list"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "chats", label: "Chats" },
            {
              value: "groups",
              label: "Groups",
              after: (
                <>
                  {/* As many as Groups' All: the groups, and the rooms made here. */}
                  {groups.length + rooms.length > 0 ? <Count n={groups.length + rooms.length} /> : null}
                  {tab !== "groups" && seen.groupsNew(latestGroup) ? <span role="img" aria-label="New activity" className="size-2 rounded-full bg-accent" /> : null}
                </>
              ),
            },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 sm:px-3">
        {loading ? (
          <div className="px-1 pt-2">
            <ListLoading count={5} />
          </div>
        ) : tab === "groups" ? (
          <GroupsTab data={data} query={query} openRow={open.roomChatId ? `room:${open.roomChatId}` : open.group ? `group:${open.group}` : undefined} seen={seen} />
        ) : whose === "everyone" ? (
          <EveryoneList data={data} query={query} current={open.sessionId} />
        ) : data.agents.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No agents yet" description="Make an agent on Agents, and you can talk to it here." />
        ) : !view.pinned && view.recent.length === 0 && view.untouched.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-base-content/65">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {view.pinned ? <ChatsRow row={view.pinned} data={data} current={rowIsOpen(view.pinned, open)} unread={unread(view.pinned)} /> : null}
            {view.pinned && (view.recent.length > 0 || view.untouched.length > 0) ? <div className="mx-3 my-1.5 h-px bg-base-content/[0.08]" /> : null}
            {view.recent.map((row) => (
              <ChatsRow key={row.key} row={row} data={data} current={rowIsOpen(row, open)} unread={unread(row)} />
            ))}
            {view.recent.length === 0 && !view.pinned?.entry?.sessionId && !query.trim() ? (
              <p className="flex items-center gap-2 px-3 py-2 text-[13px] text-base-content/65">
                <UsersRound size={14} aria-hidden="true" className="shrink-0" />
                Nobody has been talked to here yet. Pick an agent to say hi.
              </p>
            ) : null}
            {view.untouched.length > 0 ? <ListHeading>Not talked to yet</ListHeading> : null}
            {view.untouched.map((row) => (
              <ChatsRow key={row.key} row={row} data={data} current={false} unread={false} />
            ))}
          </div>
        )}
        {data.list.isError ? <p className="px-3 pt-3 text-xs text-base-content/65">The latest messages could not be loaded. Showing your agents only.</p> : null}
      </div>
    </aside>
  );
}
