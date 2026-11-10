/**
 * A room's bar: its name, its members as the `@name` a person types to reach each, who answers a message that tags
 * nobody (the router's own answer, from `/chat-list`), adding an agent, a menu to rename it or take an agent out, and
 * Delete, at the end of the bar.
 *
 * Members are shown as their tags rather than faces alone: a tag is typed, and `@nero` here is the same string the router
 * matches. On a phone the tags give way to their names in a line under the room's.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Check, ChevronLeft, Ellipsis, Pencil, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import type { Room } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { AgentTag } from "@/commons/components/chat/AgentTag";
import { StackedAvatars } from "@/commons/components/chat/Avatars";
import { useConfirm } from "@/commons/components/ui/confirm";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { useToast } from "@/commons/components/ui/toast";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";
import type { ChatListData } from "../hooks/use-chat-list";
import { HEADER_BUTTON } from "./AgentHeader";

const MENU = "rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft";

/** What a change to the room has to refresh: the list beside it, and the room's own header and transcript. */
function useRoomRefresh(chatId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    void queryClient.invalidateQueries({ queryKey: ["chat-list"] });
    void queryClient.invalidateQueries({ queryKey: ["transcript", "room", chatId] });
  };
}

export function RoomHeader({ room, data, untagged, onDelete, deleting }: { room: Room; data: ChatListData; untagged: string | undefined; onDelete: () => void; deleting: boolean }) {
  const toast = useToast();
  const refresh = useRoomRefresh(room.chatId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const members = room.members.map((member) => member.agentId);
  const name = room.title ?? members.map(data.nameOf).join(", ");
  const rename = useMutation({
    mutationFn: (title: string | null) => api.renameRoom(room.chatId, title),
    onSuccess: () => {
      setRenaming(false);
      refresh();
    },
    onError: (error: unknown) => toast.error("Could not rename the room", error),
  });

  return (
    <header className="z-20 flex shrink-0 flex-col gap-2.5 border-b border-base-content/[0.08] bg-base-100/80 px-2 py-2.5 backdrop-blur-xl sm:px-5 sm:py-3">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <Link to="/chat" className="btn btn-ghost btn-square size-11 shrink-0 rounded-[14px] md:hidden" aria-label="Back to chats">
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <StackedAvatars faces={data.faces(members)} />
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5 pl-1"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate(draft.trim() || null);
            }}
          >
            <input autoFocus className="input input-sm h-10 min-w-0 flex-1 rounded-[12px]" value={draft} maxLength={100} aria-label="Room name" placeholder="Room name" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setRenaming(false)} />
            <button type="submit" className="btn btn-primary btn-square size-10 rounded-[12px]" aria-label="Save the name" disabled={rename.isPending}>
              <Check size={16} />
            </button>
            <button type="button" className="btn btn-ghost btn-square size-10 rounded-[12px]" aria-label="Keep the name" onClick={() => setRenaming(false)}>
              <X size={16} />
            </button>
          </form>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
              <h2 className="min-w-0 truncate font-display text-lg font-medium tracking-tight text-base-content">{name}</h2>
              <p className="truncate text-xs text-base-content/65">
                <span className="md:hidden">{members.map(data.nameOf).join(", ")} and you</span>
                <span className="max-md:hidden">
                  A room · {members.length === 1 ? "1 agent" : `${members.length} agents`} and you
                </span>
              </p>
            </div>
            <AddAgentMenu room={room} data={data} refresh={refresh} />
            <RoomMenu
              room={room}
              data={data}
              refresh={refresh}
              onRename={() => {
                setDraft(room.title ?? "");
                setRenaming(true);
              }}
            />
            <DeleteRoomButton members={members} onDelete={onDelete} deleting={deleting} />
          </>
        )}
      </div>

      <ul aria-label="In this room" className="flex flex-wrap items-center gap-1.5 max-md:hidden">
        {members.map((agentId) => {
          const look = data.looks.get(agentId);
          return (
            <li key={agentId} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-base-content/[0.08] bg-base-100 py-0.5 pr-2.5 pl-0.5 text-xs">
              {look ? <AgentAvatar look={look} name={data.nameOf(agentId)} size="xxs" className="rounded-full" /> : null}
              <AgentTag agentId={agentId} bare className="truncate font-mono">
                @{agentId}
              </AgentTag>
              {untagged === agentId ? <span className="shrink-0 text-secondary">answers when nobody is tagged</span> : null}
            </li>
          );
        })}
      </ul>
    </header>
  );
}

/** Add agent: every agent not in the room yet, with the tag it will be reached by. */
function AddAgentMenu({ room, data, refresh }: { room: Room; data: ChatListData; refresh: () => void }) {
  const toast = useToast();
  const members = room.members.map((member) => member.agentId);
  const available = data.agents.filter((agent) => !members.includes(agent.id));
  const addMember = useMutation({
    mutationFn: (agentId: string) => api.addRoomMember(room.chatId, agentId),
    onSuccess: (result, agentId) => {
      refresh();
      if (result.added) toast.success(`${data.nameOf(agentId)} joined the room`);
    },
    onError: (error: unknown) => toast.error("Could not add the agent", error),
  });
  if (available.length === 0) return null;
  return (
    <DropdownMenu
      trigger={
        <>
          <UserPlus size={17} aria-hidden="true" />
          <span className="max-sm:hidden">Add agent</span>
        </>
      }
      triggerClassName={HEADER_BUTTON}
      ariaLabel="Add an agent to this room"
      width={260}
      menuClassName={MENU}
    >
      {(close) =>
        available.map((agent) => {
          const look = data.looks.get(agent.id);
          const agentName = agent.displayName || agent.id;
          return (
            <li key={agent.id}>
              <button type="button" className="min-h-11 gap-3 rounded-xl text-sm" disabled={addMember.isPending} onClick={() => { close(); addMember.mutate(agent.id); }}>
                {look ? <AgentAvatar look={look} name={agentName} size="xs" /> : null}
                <span className="min-w-0 truncate font-semibold">{agentName}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-base-content/65">@{agent.id}</span>
              </button>
            </li>
          );
        })
      }
    </DropdownMenu>
  );
}

/** Delete, in the bar: the room, its history and every member's conversation in it, asked first. */
function DeleteRoomButton({ members, onDelete, deleting }: { members: string[]; onDelete: () => void; deleting: boolean }) {
  const { ask, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        className={cn(HEADER_BUTTON, "hover:bg-error/10 hover:text-error")}
        aria-label="Delete this room"
        disabled={deleting}
        onClick={async () => {
          const confirmed = await ask({
            title: "Delete this room?",
            body: (
              <>
                The room, its history, and every member&apos;s conversation in it are deleted: {members.join(", ")}. Anything running here is cancelled. There is no undo.
              </>
            ),
            confirmLabel: "Delete room",
          });
          if (confirmed) onDelete();
        }}
      >
        <Trash2 size={17} aria-hidden="true" />
        <span className="max-sm:hidden">Delete</span>
      </button>
      {dialog}
    </>
  );
}

/** The room's menu: rename it, take an agent out — asked first, as it cannot be undone. */
function RoomMenu({ room, data, refresh, onRename }: { room: Room; data: ChatListData; refresh: () => void; onRename: () => void }) {
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const members = room.members.map((member) => member.agentId);
  const removeMember = useMutation({
    mutationFn: (agentId: string) => api.removeRoomMember(room.chatId, agentId),
    onSuccess: (_result, agentId) => {
      refresh();
      toast.info(`${data.nameOf(agentId)} left the room`, "What it already said stays in the room.");
    },
    onError: (error: unknown) => toast.error("Could not remove the agent", error),
  });
  return (
    <>
      <DropdownMenu trigger={<Ellipsis size={17} aria-hidden="true" />} triggerClassName={cn(HEADER_BUTTON, "w-11 px-0 sm:w-9")} ariaLabel="More for this room" width={260} menuClassName={MENU}>
        {(close) => (
          <>
            <li>
              <button type="button" className="min-h-11 gap-3 rounded-xl text-sm" onClick={() => { close(); onRename(); }}>
                <Pencil size={16} aria-hidden="true" /> Rename room
              </button>
            </li>
            {members.length > 1
              ? members.map((agentId) => (
                  <li key={agentId}>
                    <button
                      type="button"
                      className="min-h-11 gap-3 rounded-xl text-sm"
                      disabled={removeMember.isPending}
                      onClick={async () => {
                        close();
                        const confirmed = await ask({
                          title: `Take ${data.nameOf(agentId)} out of this room?`,
                          body: <>It stops getting messages here. What it already said stays in the room.</>,
                          confirmLabel: "Take out",
                        });
                        if (confirmed) removeMember.mutate(agentId);
                      }}
                    >
                      <UserMinus size={16} aria-hidden="true" /> Take {data.nameOf(agentId)} out
                    </button>
                  </li>
                ))
              : null}
          </>
        )}
      </DropdownMenu>
      {dialog}
    </>
  );
}
