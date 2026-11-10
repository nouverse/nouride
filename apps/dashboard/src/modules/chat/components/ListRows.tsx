/**
 * The chat list's three kinds of row, each a `ConversationRow`: an agent (its cat, its newest conversation here), a
 * room (its members stacked), a group from a chat app (its initials, its app's mark, the agents in it).
 */

import type { ChatListGroup, ChatListLine, ChatListRoom } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { GroupAvatar, MiniAvatars, StackedAvatars } from "@/commons/components/chat/Avatars";
import { ConversationRow, RowTag } from "@/commons/components/chat/ConversationRow";
import { PlatformRowTag } from "@/commons/components/chat/PlatformBadge";
import { agentChatLink } from "@/commons/hooks/use-agent-chat";
import { platformName } from "@/commons/lib/platform";
import { shortWhen } from "@/commons/lib/when";
import type { ChatListData } from "../hooks/use-chat-list";
import { lastLine, type ChatRow } from "../lib/chat-list";

/** "Working", and how many helpers are at it in the background. */
export function workingWords(working: boolean, helpers: number): string | undefined {
  const help = helpers === 1 ? "1 helper" : `${helpers} helpers`;
  if (working) return helpers > 0 ? `Working · ${help}` : "Working";
  return helpers > 0 ? `${help} at work` : undefined;
}

/** Who said a room's or a group's last line: an agent by its name, a person by the name their app shows. */
const saidBy = (data: ChatListData) => (last: ChatListLine) => (last.from === "agent" ? (last.name ? data.nameOf(last.name) : undefined) : last.name);

/** A group's name, or what it is where its app never said. */
export const groupName = (group: Pick<ChatListGroup, "name" | "platform">) => group.name || `A group on ${platformName(group.platform)}`;

function AgentRow({ row, data, current, unread }: { row: Extract<ChatRow, { kind: "agent" }>; data: ChatListData; current: boolean; unread: boolean }) {
  const { agent, entry } = row;
  const name = agent.displayName || agent.id;
  const look = data.looks.get(agent.id);
  const working = workingWords(Boolean(entry?.working), entry?.helpers ?? 0);
  return (
    <ConversationRow
      link={agentChatLink(agent.id, entry?.sessionId)}
      avatar={look ? <AgentAvatar look={look} name={name} size="sm" /> : undefined}
      name={name}
      tag={agent.id === data.orchestrator ? <RowTag>Orchestrator</RowTag> : undefined}
      {...(entry?.at ? { time: shortWhen(entry.at) } : {})}
      line={working ?? (entry?.sessionId ? (entry.last?.text ?? "") : `Say hi to ${name}`)}
      tone={working ? "working" : entry?.sessionId ? "said" : "quiet"}
      unread={unread}
      current={current}
    />
  );
}

function RoomRow({ room, data, current, unread }: { room: ChatListRoom; data: ChatListData; current: boolean; unread: boolean }) {
  const name = room.title || room.members.map(data.nameOf).join(", ");
  return (
    <ConversationRow
      link={{ to: "/chat/room/$chatId", params: { chatId: room.chatId } }}
      avatar={<StackedAvatars faces={data.faces(room.members)} />}
      name={name}
      time={shortWhen(room.at)}
      line={room.working ? "Working" : (lastLine(room.last, saidBy(data)) ?? "Nothing said here yet")}
      tone={room.working ? "working" : room.last ? "said" : "quiet"}
      unread={unread}
      current={current}
    />
  );
}

function GroupRow({ group, data, current, unread }: { group: ChatListGroup; data: ChatListData; current: boolean; unread: boolean }) {
  return (
    <ConversationRow
      link={{ to: "/chat/group/$platform/$chatId", params: { platform: group.platform, chatId: group.chatId } }}
      avatar={<GroupAvatar name={groupName(group)} />}
      name={groupName(group)}
      tag={<PlatformRowTag platform={group.platform} />}
      time={shortWhen(group.at)}
      line={group.working ? "Working" : (lastLine(group.last, saidBy(data)) ?? "No agent has said anything here yet")}
      tone={group.working ? "working" : group.last ? "said" : "quiet"}
      trailing={group.agents.length > 0 ? <MiniAvatars faces={data.faces(group.agents)} /> : undefined}
      unread={unread}
      current={current}
    />
  );
}

/** Any row of Chats, by its kind. */
export function ChatsRow({ row, data, current, unread }: { row: ChatRow; data: ChatListData; current: boolean; unread: boolean }) {
  if (row.kind === "agent") return <AgentRow row={row} data={data} current={current} unread={unread} />;
  if (row.kind === "room") return <RoomRow room={row.room} data={data} current={current} unread={unread} />;
  return <GroupRow group={row.group} data={data} current={current} unread={unread} />;
}
