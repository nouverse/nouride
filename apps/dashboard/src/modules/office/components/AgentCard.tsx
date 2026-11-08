import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Moon, Palette, Sun, Target, X } from "lucide-react";
import { api, type AgentSummary } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { AgentStatusBadge } from "@/commons/components/agents/agent-status-badge";
import { ErrorNote } from "@/commons/components/ui/ui";
import { OrchestratorBadge, useOrchestrator } from "@/commons/components/agents/AgentName";
import type { Status } from "@/commons/office/lib/layout";

/** A mission's turns run on this connection; its chat id is the mission's. */
const MISSION_GATEWAY = "web:mission";

/**
 * A cat, clicked: what its agent is doing and where, why it cannot work if it cannot, and what a person does from here
 * — put it to sleep or wake it, open the chat or the mission it is in, change its look.
 */
export function AgentCard({ agent, status, onClose }: { agent: AgentSummary; status: Status; onClose: () => void }) {
  const me = useMe();
  const orchestrator = useOrchestrator();
  const editable = canWrite(me.data ?? null);
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: (action: "sleep" | "wake") => api.agentAction(agent.id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const working = agent.activity?.working ?? [];
  const asleep = status === "asleep";

  return (
    <div className="space-y-4 rounded-2xl border border-base-content/10 bg-base-100 p-4 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-lg font-bold tracking-tight">{agent.displayName}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <AgentStatusBadge agent={agent} />
            {/* The same mark the other pages give it, and its name wears over its cat. */}
            {agent.id === orchestrator ? <OrchestratorBadge /> : null}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-xs btn-circle" onClick={onClose} aria-label="Close">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {agent.activity?.unavailable ? <p className="text-error text-xs">Cannot work: {agent.activity.unavailable}</p> : null}

      {working.length > 0 || (agent.activity?.jobs ?? 0) > 0 || (agent.activity?.waiting ?? 0) > 0 ? (
        <ul className="space-y-1 text-sm">
          {working.map((place) =>
            place.gatewayId === MISSION_GATEWAY ? (
              <li key={`${place.gatewayId}:${place.chatId}`}>
                <Link to="/missions/$missionId" params={{ missionId: place.chatId }} className="link link-hover inline-flex items-center gap-1.5">
                  <Target size={14} aria-hidden="true" /> Mission {place.chatId.slice(0, 12)}
                </Link>
              </li>
            ) : (
              <li key={`${place.gatewayId}:${place.chatId}`}>
                <Link to="/chat/$sessionId" params={{ sessionId: `ses_${agent.id}:${place.gatewayId}:${place.chatId}` }} className="link link-hover inline-flex items-center gap-1.5">
                  <MessageSquare size={14} aria-hidden="true" /> {place.gatewayId} · {place.chatId}
                </Link>
              </li>
            ),
          )}
          {(agent.activity?.jobs ?? 0) > 0 ? <li className="text-base-content/70">{agent.activity!.jobs} background job(s)</li> : null}
          {(agent.activity?.waiting ?? 0) > 0 ? <li className="text-warning">{agent.activity!.waiting} waiting for a person</li> : null}
        </ul>
      ) : (
        <p className="text-base-content/70 text-sm">{asleep ? "Asleep: it takes no work until someone wakes it." : "Nothing running."}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm gap-1.5" disabled={!editable || act.isPending} onClick={() => act.mutate(asleep ? "wake" : "sleep")}>
          {asleep ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />} {asleep ? "Wake" : "Sleep"}
        </button>
        {/* A new chat with this agent: `/chat` alone started one with the orchestrator, whoever was picked. */}
        <Link to="/chat" search={{ agent: agent.id }} className="btn btn-sm gap-1.5">
          <MessageSquare size={14} aria-hidden="true" /> Open chat
        </Link>
        <Link to="/agents/$agentId/look" params={{ agentId: agent.id }} className="btn btn-sm gap-1.5">
          <Palette size={14} aria-hidden="true" /> Edit look
        </Link>
      </div>
      <ErrorNote error={act.error} />
    </div>
  );
}
