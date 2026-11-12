/**
 * What is inside the floating chat: its bar (the agent it is on, picked there; a new conversation with it; a way to the
 * same conversation on the Chats page; its close) over that agent's conversation: the person's newest one with it, the
 * one its row on Chats opens (`/chat-list`), or a new one where there is none or the person asked for one.
 *
 * The conversation is the Chats page's own (`commons/components/chat/Conversation.tsx`): the same transcript, live
 * turn, approvals, steps, files and stop. What differs is where it goes. The page under the panel stays where it is, so
 * a new conversation's id is kept here and not in the address, and each message says which page that is.
 *
 * Drawn only while the chat is open: closed, no conversation is drawn, so nothing is asked of the daemon and no stream
 * is held (`use-event-stream.ts`: a browser has six connections to give).
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, Maximize2, MessageSquarePlus, X } from "lucide-react";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { ChatLoading } from "@/commons/components/chat/ChatLoading";
import { Conversation, STATUS_TONES, type ConversationNow } from "@/commons/components/chat/Conversation";
import { RowTag } from "@/commons/components/chat/ConversationRow";
import { ErrorNote } from "@/commons/components/ui/ui";
import { agentChatLink } from "@/commons/hooks/use-agent-chat";
import type { useChatAgents } from "@/commons/hooks/use-chat-agents";
import { orchestratorFirst } from "@/commons/lib/agents";
import { api } from "@/commons/lib/api";
import { pickFloatingAgent, takeFloatingDraft } from "@/commons/lib/floating-chat";
import { cn } from "@/commons/lib/utils";
import { pageOpen } from "./page-open";

/** A button of the bar that is an icon alone: a finger's size on a phone. */
const ICON_BUTTON = "btn btn-ghost btn-square size-9 shrink-0 rounded-[12px] text-base-content/65 hover:text-base-content max-sm:size-11";
const ROW = "flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left outline-none hover:bg-base-content/[0.05] focus-visible:ring-2 focus-visible:ring-secondary/60";

/** A conversation a first message here started, and the one the list named for its agent then (none, or the one it left). */
export interface Started {
  id: string;
  over?: string;
}

/**
 * The conversation the panel is on with an agent: the one the list names, the person's newest. One a message here just
 * started comes first while the list still names what it named then: it has not caught up. Once it names anything
 * else, that one or a newer one started elsewhere, the list is right again.
 */
export function conversationOf(listed: string | undefined, started: Started | undefined): string | undefined {
  return started && listed === started.over ? started.id : listed;
}

export function FloatingPanel({
  agentId,
  chat,
  box,
  started: [started, setStarted],
  draft,
  focusBox,
  onClose,
}: {
  agentId: string;
  chat: ReturnType<typeof useChatAgents>;
  /** What is written in the box and not sent, kept by the shell: the panel is not drawn while the chat is closed. */
  box: [string, Dispatch<SetStateAction<string>>];
  /**
   * The conversations a first message here started, by agent, kept by the shell too: used while the list below does
   * not know one yet. The daemon writes a conversation down as its first turn starts, a moment after the list was
   * read again for it, and closed and opened in that moment the panel drew a new chat where one had just begun.
   */
  started: [Record<string, Started>, Dispatch<SetStateAction<Record<string, Started>>>];
  /** A message written for the person to send (`AskAgentButton`). */
  draft: string | null;
  /**
   * The box takes the focus once the conversation is drawn, from a tablet's width up. On a phone the sheet keeps it
   * (`Drawer`): a focused field brings the keyboard up over what was said.
   */
  focusBox: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  /**
   * The person's newest conversation with each agent, as the Chats page lists them. Read again at every opening, so one
   * started or deleted elsewhere since is the one shown; what was read last is drawn meanwhile, so the panel opens at
   * once on a slow line too.
   */
  const list = useQuery({ queryKey: ["chat-list", "mine"], queryFn: () => api.chatList("mine"), retry: false, refetchOnMount: "always" });
  const listed = (agent: string) => list.data?.agents.find((entry) => entry.agentId === agent)?.sessionId;
  /**
   * The agent the person asked a new conversation with, until its first message starts one or they pick another agent.
   * Kept here and not by the shell: put away without a word written, the panel opens on the newest conversation again.
   */
  const [fresh, setFresh] = useState<string | null>(null);
  const sessionId = fresh === agentId ? undefined : conversationOf(listed(agentId), started[agentId]);
  /**
   * Nothing can be written before the list was read once: the panel would not know the conversation the person
   * already has with the agent, and their message would start a second one beside it.
   */
  const ready = list.data !== undefined;

  useEffect(() => {
    if (!ready || !focusBox || picking) return;
    // Only while the focus is in the panel or nowhere: by now the person may be in a field of the page under it.
    const at = document.activeElement;
    if (at && at !== document.body && !at.closest("[data-floating-chat]")) return;
    root.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)")?.focus();
  }, [ready, focusBox, agentId, picking, fresh]);

  const agents = orchestratorFirst(chat.agents, chat.orchestrator);
  const name = chat.nameOf(agentId);
  const look = chat.looks.get(agentId);

  const bar = (now?: ConversationNow) => (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-base-content/[0.08] pr-2 pl-2">
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[14px] px-1.5 text-left outline-none hover:bg-base-content/[0.05] focus-visible:ring-2 focus-visible:ring-secondary/60"
        aria-expanded={picking}
        aria-label={`Chatting with ${name}. Pick another agent`}
        onClick={() => setPicking((was) => !was)}
      >
        {look ? <AgentAvatar look={look} name={name} size="xs" /> : null}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-display text-base font-medium tracking-tight text-base-content">{name}</span>
            <ChevronDown size={15} aria-hidden="true" className={cn("shrink-0 text-base-content/65 transition-transform duration-150", picking && "rotate-180")} />
          </span>
          {now?.status.words ? <span className={cn("block truncate text-xs font-semibold", STATUS_TONES[now.status.tone])}>{now.status.words}</span> : null}
        </span>
      </button>
      {/* Only where there is a conversation to leave: with none yet, the panel is on a new one already. */}
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={`Start a new conversation with ${name}`}
        title="New chat"
        disabled={!ready || sessionId === undefined}
        onClick={() => {
          setPicking(false);
          setFresh(agentId);
        }}
      >
        <MessageSquarePlus size={17} aria-hidden="true" />
      </button>
      <Link {...agentChatLink(agentId, sessionId)} onClick={onClose} className={ICON_BUTTON} aria-label="Open this conversation in Chats" title="Open in Chats">
        <Maximize2 size={16} aria-hidden="true" />
      </Link>
      <button type="button" className={ICON_BUTTON} aria-label="Close the chat" onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
  );

  return (
    <div
      ref={root}
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        // Escape puts the list of agents away first; the next one closes the chat.
        if (event.key !== "Escape" || !picking) return;
        event.preventDefault();
        event.stopPropagation();
        setPicking(false);
      }}
    >
      {ready ? (
        <Conversation
          {...(sessionId ? { sessionId } : {})}
          agent={agentId}
          agents={chat}
          narrow
          box={box}
          onSession={(id, agent) => {
            const over = listed(agent);
            setStarted((was) => ({ ...was, [agent]: { id, ...(over ? { over } : {}) } }));
            setFresh(null);
          }}
          draft={{ text: draft ?? undefined, onTaken: takeFloatingDraft }}
          page={() => pageOpen({ basepath: router.basepath, pathname: router.state.location.pathname, search: router.state.location.searchStr })}
          header={bar}
        />
      ) : (
        <>
          {bar()}
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {list.isError ? (
              <div className="space-y-3 py-6">
                <ErrorNote error={list.error} />
                <button type="button" className="btn btn-sm rounded-full" onClick={() => void list.refetch()}>
                  Try again
                </button>
              </div>
            ) : (
              <ChatLoading />
            )}
          </div>
        </>
      )}

      {picking ? (
        <AgentList
          agents={agents}
          chat={chat}
          current={agentId}
          onPick={(agent) => {
            setPicking(false);
            setFresh(null);
            pickFloatingAgent(agent);
          }}
        />
      ) : null}
    </div>
  );
}

/** The agents to chat with, over the conversation: the orchestrator first, the one the panel is on marked. */
function AgentList({ agents, chat, current, onPick }: { agents: ReturnType<typeof useChatAgents>["agents"]; chat: ReturnType<typeof useChatAgents>; current: string; onPick: (agentId: string) => void }) {
  return (
    <div className="absolute inset-x-0 top-14 bottom-0 z-30 overflow-y-auto overscroll-contain bg-base-100 p-1.5 animate-fade">
      <p className="px-2.5 pt-2 pb-1 text-xs font-semibold text-base-content/65">Chat with</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const label = agent.displayName || agent.id;
          const face = chat.looks.get(agent.id);
          return (
            <li key={agent.id}>
              <button type="button" aria-current={agent.id === current ? "true" : undefined} className={cn(ROW, agent.id === current && "bg-secondary/10")} onClick={() => onPick(agent.id)}>
                {face ? <AgentAvatar look={face} name={label} size="xs" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{label}</span>
                    {agent.id === chat.orchestrator ? <RowTag>Orchestrator</RowTag> : null}
                  </span>
                  {agent.headline ? <span className="block truncate text-xs text-base-content/65">{agent.headline}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
