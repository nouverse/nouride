/**
 * The list's +: start a chat with an agent, or make a room. A chat with an agent is a new conversation with it — the
 * agent's row already carries on its newest one — so its picker lists every agent, the orchestrator first.
 */

import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquarePlus, Plus, Users } from "lucide-react";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { RowTag } from "@/commons/components/chat/ConversationRow";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { PopoverSheet } from "@/commons/components/ui/PopoverSheet";
import { orchestratorFirst } from "@/commons/lib/agents";
import type { ChatListData } from "../hooks/use-chat-list";
import { NewRoomDialog } from "./NewRoom";

export function StartMenu({ data }: { data: ChatListData }) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLSpanElement>(null);
  const [picking, setPicking] = useState(false);
  const [making, setMaking] = useState(false);
  const agents = orchestratorFirst(data.agents, data.orchestrator);

  return (
    <span ref={anchor} className="inline-flex">
      <DropdownMenu
        trigger={<Plus size={18} aria-hidden="true" />}
        triggerClassName="btn btn-ghost btn-square size-11 rounded-[14px] bg-base-content/[0.05] text-base-content hover:bg-base-content/[0.09] sm:size-10"
        ariaLabel="Start a chat or a room"
        width={260}
        menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
      >
        {(close) => (
          <>
            <li>
              <button type="button" className="min-h-11 gap-3 rounded-xl text-sm font-semibold" onClick={() => { close(); setPicking(true); }}>
                <MessageSquarePlus size={17} aria-hidden="true" /> Chat with an agent
              </button>
            </li>
            <li>
              <button type="button" className="min-h-11 gap-3 rounded-xl text-sm font-semibold" onClick={() => { close(); setMaking(true); }}>
                <Users size={17} aria-hidden="true" /> New room
              </button>
            </li>
          </>
        )}
      </DropdownMenu>

      <PopoverSheet open={picking} onClose={() => setPicking(false)} anchor={anchor} label="Chat with an agent" width={320}>
        <p className="px-4 pt-3 pb-1 font-display text-base font-medium">Chat with an agent</p>
        <ul className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">
          {agents.map((agent) => {
            const name = agent.displayName || agent.id;
            const look = data.looks.get(agent.id);
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left outline-none hover:bg-base-content/[0.05] focus-visible:ring-2 focus-visible:ring-secondary/60"
                  onClick={() => {
                    setPicking(false);
                    void navigate({ to: "/chat", search: { agent: agent.id } });
                  }}
                >
                  {look ? <AgentAvatar look={look} name={name} size="xs" /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{name}</span>
                      {agent.id === data.orchestrator ? <RowTag>Orchestrator</RowTag> : null}
                    </span>
                    {agent.headline ? <span className="block truncate text-xs text-base-content/65">{agent.headline}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverSheet>

      <NewRoomDialog open={making} onClose={() => setMaking(false)} data={data} />
    </span>
  );
}
