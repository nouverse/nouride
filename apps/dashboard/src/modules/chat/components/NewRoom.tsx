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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Check, Crown, Users } from "lucide-react";
import { api } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";

export function NewRoomButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createRoom({ agentIds: picked, ...(title.trim() ? { title: title.trim() } : {}) }),
    onSuccess: (result) => {
      dialogRef.current?.close();
      setPicked([]);
      setTitle("");
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void navigate({ to: "/chat/room/$chatId", params: { chatId: result.room.chatId } });
    },
    onError: (error: unknown) => toast.error("Could not create the room", error),
  });

  /**
   * The orchestrator first, then the rest alphabetically.
   *
   * The same order the agent picker uses, and for the same reason: the orchestrator is the one most rooms
   * will include, and making the reader find it alphabetically among six near-identical names is a
   * tax paid on every single room. `/status` reports the daemon's default, so this does not need a
   * second source of truth for what "first" means.
   */
  const orchestrator = status.data?.orchestrator;
  const agents = [...(status.data?.agents ?? [])].sort((a, b) => {
    if (a.id === orchestrator) return -1;
    if (b.id === orchestrator) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
    );

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm gap-1.5 rounded-xl active:scale-95 transition-all"
        onClick={() => dialogRef.current?.showModal()}
        // Its word is hidden on a phone, and a reader takes nothing from text that is not drawn.
        aria-label="New room"
      >
        <Users size={15} aria-hidden="true" />
        <span className="hidden sm:inline">New Room</span>
      </button>

      <dialog ref={dialogRef} className="modal">
        <div className="modal-box rounded-2xl">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Users size={16} className="text-primary" /> New room
          </h3>
          <p className="mt-1 text-sm text-base-content/65">
            One conversation, several agents. Address one by tagging it ({" "}
            <span className="font-mono text-xs">@nero</span>), and they can hand work to each other
            the same way.
          </p>

          <label className="mt-4 block">
            <span className="text-xs font-semibold text-base-content/70">Name (optional)</span>
            <input
              className="input input-sm mt-1 w-full rounded-xl"
              placeholder="Product × Eng"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <div className="mt-4">
            <span className="text-xs font-semibold text-base-content/70">
              Agents {picked.length > 0 ? `· ${picked.length} selected` : ""}
            </span>
            <div className="mt-1.5 max-h-64 space-y-1 overflow-y-auto">
              {agents.map((agent) => {
                const on = picked.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggle(agent.id)}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-all ${
                      on
                        ? "border-primary/40 bg-primary/10"
                        : "border-base-content/[0.08] hover:bg-base-200/60"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1 truncate text-sm font-semibold">
                        {agent.id === orchestrator ? <Crown size={11} className="shrink-0" aria-label="orchestrator" /> : null}
                        {agent.displayName}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-base-content/65">
                        @{agent.id}
                      </span>
                    </span>
                    {on ? <Check size={14} className="text-primary shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            One agent is allowed and behaves sensibly: with a single member there is no ambiguity, so
            an untagged message is answered — which is the same rule a one-to-one chat follows.
          */}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm rounded-xl"
              disabled={picked.length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
              Create room
            </button>
          </div>
        </div>
        {/* Clicking outside closes it, which is what daisyUI's backdrop form is for. */}
        <form method="dialog" className="modal-backdrop">
          <button type="submit" aria-label="Close" />
        </form>
      </dialog>
    </>
  );
}
