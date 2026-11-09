/**
 * Making a room: pick the agents, optionally name it.
 *
 * The agents are chosen *before* the first message rather than gathered as they are tagged, and that
 * ordering is not cosmetic. The daemon reads a room's membership list to decide who may answer in it
 * — the prompt's OTHER AGENTS section and the guard on untagged messages both narrow on it — so a
 * message that arrived before the list did would be routed against the wrong set.
 *
 * A room is created empty and navigated to. It has no session and no turns until somebody speaks,
 * which is why it is addressed by its chat id.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { useToast } from "@/commons/components/ui/toast";
import type { ChatListData } from "../hooks/use-chat-list";

export function NewRoomDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: ChatListData }) {
  return <Leaving value={open}>{() => <NewRoomBox onClose={onClose} data={data} />}</Leaving>;
}

function NewRoomBox({ onClose, data }: { onClose: () => void; data: ChatListData }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");

  const create = useMutation({
    mutationFn: () => api.createRoom({ agentIds: picked, ...(title.trim() ? { title: title.trim() } : {}) }),
    onSuccess: (result) => {
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["chat-list"] });
      void navigate({ to: "/chat/room/$chatId", params: { chatId: result.room.chatId } });
    },
    onError: (error: unknown) => toast.error("Could not create the room", error),
  });

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  /**
   * The orchestrator first: the one most rooms will include, and making the reader find it among six near-identical
   * names is a tax paid on every room.
   */
  const agents = orchestratorFirst(data.agents, data.orchestrator);
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label="New room">
      <form
        className="modal-box flex max-h-[90dvh] max-w-lg flex-col gap-4 overflow-hidden rounded-[26px] p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked.length > 0) create.mutate();
        }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="font-display text-xl font-medium tracking-tight">New room</h2>
            <p className="text-sm leading-relaxed text-base-content/70">A conversation with several agents at once. Tag one with @ to ask it.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-square size-11 rounded-xl sm:size-9" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Name <span className="sr-only">(optional)</span>
          <input className="input w-full rounded-[14px] font-medium" placeholder="Optional, like Launch crew" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
        </label>

        {/* `min-w-0`: a fieldset is otherwise as wide as its widest line, and a long headline ran past the dialog. */}
        <fieldset className="flex min-h-0 min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-sm font-semibold">Agents in this room</legend>
          <div className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1">
            {agents.map((agent) => {
              const name = agent.displayName || agent.id;
              const look = data.looks.get(agent.id);
              const sub = [agent.id === data.orchestrator ? "Orchestrator" : "", agent.headline ?? ""].filter(Boolean).join(" · ");
              return (
                <label key={agent.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-base-content/[0.04]">
                  <input type="checkbox" className="checkbox checkbox-sm rounded-md" checked={picked.includes(agent.id)} onChange={() => toggle(agent.id)} />
                  {look ? <AgentAvatar look={look} name={name} size="xs" /> : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    {sub ? <span className="truncate text-xs text-base-content/65">{sub}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost rounded-[14px]" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary rounded-[14px]" disabled={picked.length === 0 || create.isPending}>
            {create.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            {picked.length === 0 ? "Create room" : `Create room · ${picked.length} ${picked.length === 1 ? "agent" : "agents"}`}
          </button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>,
  );
}
