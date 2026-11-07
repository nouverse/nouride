/**
 * A room's identity in the header: what it is called, and who is in it.
 *
 * Replaces the agent picker, which is the right control for a one-to-one conversation and a wrong
 * one here — in a room nobody is selected, and the person chooses who they are talking to by tagging
 * them in the message. A picker beside that would suggest a "current agent" the router does not have.
 *
 * Members are shown as names rather than avatars alone, because a tag is typed and the thing a
 * person needs from this bar is the exact token that reaches somebody. `@nero` in the list is the
 * same string the router matches.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Plus, Trash2, Users, X } from "lucide-react";
import { api, type Room } from "@/commons/lib/api";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";

export function RoomBar({ room }: { room: Room }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  /**
   * The agents this daemon has, from `/status` — the same source the agent picker reads.
   *
   * Shared query key, so React Query serves this from the request the page already made rather than
   * issuing a second one for the same list.
   */
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    void queryClient.invalidateQueries({ queryKey: ["transcript", "room", room.chatId] });
  };

  const rename = useMutation({
    mutationFn: (title: string | null) => api.renameRoom(room.chatId, title),
    onSuccess: () => {
      setRenaming(false);
      refresh();
    },
    onError: (error: unknown) => toast.error("Could not rename the room", error),
  });

  const addMember = useMutation({
    mutationFn: (agentId: string) => api.addRoomMember(room.chatId, agentId),
    onSuccess: (result, agentId) => {
      refresh();
      // `added` is false when it was already in — worth saying, because the menu that offered it
      // should not have.
      if (result.added) toast.success(`${agentId} joined the room`);
    },
    onError: (error: unknown) => toast.error("Could not add the agent", error),
  });

  const deleteRoom = useMutation({
    mutationFn: () => api.deleteRoom(room.chatId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(
        "Room deleted",
        `${result.turns} answer(s) and every member's conversation here went with it.`,
      );
      void navigate({ to: "/chat" });
    },
    onError: (error: unknown) => toast.error("Could not delete the room", error),
  });

  const removeMember = useMutation({
    mutationFn: (agentId: string) => api.removeRoomMember(room.chatId, agentId),
    onSuccess: (_result, agentId) => {
      refresh();
      toast.info(`${agentId} left the room`, "What it already said stays in the transcript.");
    },
    onError: (error: unknown) => toast.error("Could not remove the agent", error),
  });

  const members = new Set(room.members.map((member) => member.agentId));
  const available = (status.data?.agents ?? []).filter((agent) => !members.has(agent.id));
  const name = room.title ?? room.members.map((member) => member.agentId).join(", ");

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Users size={14} />
      </span>

      {renaming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate(draft.trim() || null);
          }}
        >
          <input
            autoFocus
            className="input input-xs w-40 rounded-lg"
            value={draft}
            placeholder="Room name"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
          />
          <button type="submit" className="btn btn-primary btn-xs btn-square rounded-lg" aria-label="Save name">
            <Check size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square rounded-lg"
            onClick={() => setRenaming(false)}
            aria-label="Cancel"
          >
            <X size={12} />
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="min-w-0 truncate text-left text-xs font-semibold text-base-content sm:text-sm"
          title="Rename this room"
          onClick={() => {
            setDraft(room.title ?? "");
            setRenaming(true);
          }}
        >
          {name}
        </button>
      )}

      <div className="hidden items-center gap-1 sm:flex">
        {room.members.map((member) => (
          <span
            key={member.agentId}
            className="group inline-flex items-center gap-1 rounded-full bg-base-200/70 px-2 py-0.5 font-mono text-[10px] text-base-content/70"
          >
            @{member.agentId}
            <button
              type="button"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={`Remove ${member.agentId}`}
              disabled={removeMember.isPending}
              onClick={async () => {
                const confirmed = await ask({
                  title: `Remove ${member.agentId} from this room?`,
                  body: (
                    <>
                      It stops receiving messages here. What it already said stays in the transcript:
                      removing an agent is not deleting its half of the conversation.
                    </>
                  ),
                  confirmLabel: "Remove",
                });
                if (confirmed) removeMember.mutate(member.agentId);
              }}
            >
              <X size={10} />
            </button>
          </span>
        ))}

        {available.length > 0 && (
          <DropdownMenu
            trigger={<Plus size={13} />}
            triggerClassName="btn btn-ghost btn-xs btn-square rounded-lg"
            ariaLabel="Add an agent"
            width={208}
            menuClassName="rounded-xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-lg"
          >
            {(close) =>
              available.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="text-xs"
                    disabled={addMember.isPending}
                    onClick={() => {
                      close();
                      addMember.mutate(agent.id);
                    }}
                  >
                    <span className="font-mono">@{agent.id}</span>
                    <span className="text-base-content/65">{agent.displayName}</span>
                  </button>
                </li>
              ))
            }
          </DropdownMenu>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square rounded-lg text-base-content/65 hover:text-error"
          aria-label="Delete this room"
          title="Delete this room"
          disabled={deleteRoom.isPending}
          onClick={async () => {
            const confirmed = await ask({
              title: `Delete this room?`,
              body: (
                <>
                  The room, its history, and every member&apos;s conversation in it are deleted:
                  {" "}
                  {room.members.map((member) => member.agentId).join(", ")}. Anything running here is
                  cancelled. There is no undo.
                </>
              ),
              confirmLabel: "Delete room",
            });
            if (confirmed) deleteRoom.mutate();
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {dialog}
    </div>
  );
}
