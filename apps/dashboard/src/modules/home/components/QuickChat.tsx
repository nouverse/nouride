/**
 * Quick chat on Home (0.8.24): one line to an agent without opening Chats first. Sent as the chat page sends it, and the
 * conversation it started opens, where the answer arrives. From a laptop's width up: on a phone "+ Chat" floats where
 * this card's field would be, and a floating button never covers a composer.
 */

import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Tag } from "@/commons/components/ui/Tag";
import { OrchestratorBadge } from "@/commons/components/agents/AgentName";
import { useToast } from "@/commons/components/ui/toast";

export function QuickChat({ agents, orchestrator }: { agents: AgentSummary[]; orchestrator: string | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [agent, setAgent] = useState("");
  const [text, setText] = useState("");
  const chosen = agents.find((one) => one.id === agent) ?? agents[0];
  const send = useMutation({
    mutationFn: (input: { text: string; agent: string }) => api.chatSend(input),
    onSuccess: ({ sessionId }) => void navigate({ to: "/chat/$sessionId", params: { sessionId } }),
    onError: (error) => toast.error("Could not send your message", error),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const words = text.trim();
    if (!words || !chosen) return;
    send.mutate({ text: words, agent: chosen.id });
  };
  if (!chosen) return null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-[22px] max-lg:hidden border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <Tag tone="mine">Quick chat</Tag>
        {agents.length > 1 && (
          <select className="select select-sm select-ghost w-auto max-w-[60%] rounded-full" aria-label="Who to ask" value={chosen.id} onChange={(event) => setAgent(event.target.value)}>
            {agents.map((one) => (
              <option key={one.id} value={one.id}>
                {one.displayName || one.id}
                {one.id === orchestrator ? " (orchestrator)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* The orchestrator marked as everywhere else: the one that answers a message naming no agent, and hands work on. */}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-base-content/70">
        <span>Ask {chosen.displayName || chosen.id}</span>
        {chosen.id === orchestrator && <OrchestratorBadge />}
        <span>something; the chat opens with the answer.</span>
      </p>
      <div className="mt-auto flex items-center gap-2 rounded-full border border-base-content/10 bg-base-100 py-1 pr-1 pl-4 focus-within:border-secondary/50">
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Message ${chosen.displayName || chosen.id}…`}
          aria-label={`Message ${chosen.displayName || chosen.id}`}
          disabled={send.isPending}
        />
        <button type="submit" className="btn btn-primary btn-circle btn-sm" aria-label="Send" disabled={send.isPending || !text.trim()}>
          {send.isPending ? <span className="loading loading-spinner loading-xs" /> : <ArrowUp size={16} aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}
