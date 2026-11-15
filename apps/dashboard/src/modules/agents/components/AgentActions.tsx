/**
 * An agent's row, opened: what it is doing and where, why it cannot work if it cannot, and what a person does from
 * here: open its page, open its chat, put it to sleep or wake it, look through its folder, change its look. One place
 * for these, under the agent's row in the list, whether the row was opened there or by picking its cat in the Office.
 */

import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, MessageSquare, Moon, Palette, SquareArrowOutUpRight, Sun, Target } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { useAgentChatLink } from "@/commons/hooks/use-agent-chat";
import { ErrorNote } from "@/commons/components/ui/ui";
import type { Status } from "@/commons/office/lib/layout";

/** A mission's turns run on this connection; its chat id is the mission's. */
const MISSION_GATEWAY = "web:mission";

export function AgentActions({ agent, status }: { agent: AgentSummary; status: Status }) {
  const me = useMe();
  const editable = canWrite(me.data ?? null);
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: (action: "sleep" | "wake") => api.agentAction(agent.id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const chat = useAgentChatLink(agent.id);
  const working = agent.activity?.working ?? [];
  const asleep = status === "asleep";

  return (
    <div className="space-y-3" data-agent-actions>
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
        {/* Its own page first: everything else about it is there. */}
        <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="btn btn-primary btn-sm gap-1.5">
          <SquareArrowOutUpRight size={14} aria-hidden="true" /> Details
        </Link>
        {/* This agent's newest conversation, as its row in the chat list opens; a new chat with it when it has none. */}
        <Link {...chat} className="btn btn-sm gap-1.5">
          <MessageSquare size={14} aria-hidden="true" /> Open chat
        </Link>
        <button type="button" className="btn btn-sm gap-1.5" disabled={!editable || act.isPending} onClick={() => act.mutate(asleep ? "wake" : "sleep")}>
          {asleep ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />} {asleep ? "Wake" : "Sleep"}
        </button>
        {/* Its own folder in the workspace: an admin's to look through, as its tab on the agent's page is. */}
        {isAdmin(me.data ?? null) ? (
          <Link to="/agents/$agentId/workspace" params={{ agentId: agent.id }} search={{ path: "" }} className="btn btn-sm gap-1.5">
            <FolderOpen size={14} aria-hidden="true" /> Workspace
          </Link>
        ) : null}
        <Link to="/agents/$agentId/look" params={{ agentId: agent.id }} className="btn btn-sm gap-1.5">
          <Palette size={14} aria-hidden="true" /> Edit look
        </Link>
      </div>
      <ErrorNote error={act.error} />
    </div>
  );
}
