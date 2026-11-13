/**
 * The conversation open on the Chats page: the conversation itself (`commons/components/chat/Conversation.tsx`, the one
 * the floating chat draws too) with what is this page's own around it. The bar over it (an agent's, a room's), an
 * agent's History and its work notes in drawers either side, deleting it, and its address: a new chat's first message
 * goes to its conversation's address, and a message written for the person leaves the address once it is in the box.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Conversation } from "@/commons/components/chat/Conversation";
import { useWorkNotes } from "@/commons/hooks/use-notes";
import { canWrite, useMe } from "@/commons/lib/session";
import type { ChatListData } from "../hooks/use-chat-list";
import { useOpenChat } from "../hooks/use-open-chat";
import { AgentHeader } from "./AgentHeader";
import type { FirstChoice } from "./ChatChoice";
import { HistoryPanel } from "./HistoryPanel";
import { NotesPanel } from "./NotesPanel";
import { RoomHeader } from "./RoomHeader";

export function OpenConversation(
  { sessionId, roomChatId, agent, draft, data }: { sessionId?: string; roomChatId?: string; agent?: string; draft?: string; data: ChatListData },
) {
  const navigate = useNavigate();
  const me = useMe();

  const open = useOpenChat({
    ...(sessionId ? { sessionId } : {}),
    ...(roomChatId ? { roomChatId } : {}),
    onLeave: () => void navigate({ to: "/chat" }),
  });

  /**
   * The agent's work notes, in a drawer on the right — a one-to-one conversation's, once the daemon has answered for
   * them: a room has a session per member, and a daemon that keeps none (501), or predates them (404), offers no toggle.
   */
  const workNotes = useWorkNotes(sessionId);
  /** Which conversation the drawer was opened in, so a new chat's first answer does not open it. */
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const notesOpen = notesFor !== null && notesFor === sessionId && Boolean(workNotes.data);
  const closeNotes = () => setNotesFor(null);
  // History and the notes are drawers either side of the pane, one open at a time; a conversation picked in History opens
  // where it was, and the drawer is done.
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => setHistoryOpen(false), [sessionId]);
  const toggleNotes = () => {
    // Opened, read again: what the agent wrote in a turn on another connection is there without waiting for one here.
    if (!notesOpen) void workNotes.refetch();
    setNotesFor(notesOpen ? null : (sessionId ?? null));
  };

  const roomEntry = roomChatId ? data.list.data?.rooms.find((one) => one.chatId === roomChatId) : undefined;

  /**
   * The model and effort picked for a conversation not begun, which go with its first message (`ChatChoice`). Another
   * agent, or a conversation that has begun, starts from nothing picked: a pick is one conversation's.
   */
  const [first, setFirst] = useState<FirstChoice>({});
  useEffect(() => setFirst({}), [agent, sessionId]);
  const writes = canWrite(me.data ?? null);

  return (
    <Conversation
      {...(sessionId ? { sessionId } : {})}
      {...(roomChatId ? { roomChatId } : {})}
      {...(agent ? { agent } : {})}
      agents={data}
      untagged={roomEntry?.untagged}
      onSession={(id) => void navigate({ to: "/chat/$sessionId", params: { sessionId: id }, replace: true })}
      // Dropped from the address once it is in the box, so a reload does not put it back; the agent it named stays.
      draft={{ text: draft, onTaken: () => void navigate({ to: "/chat", search: agent ? { agent } : {}, replace: true }) }}
      firstChoice={() => first}
      header={(now) =>
        now.room ? (
          <RoomHeader room={now.room} data={data} untagged={roomEntry?.untagged} onDelete={open.deleteOnScreen} deleting={open.deleting} />
        ) : (
          <AgentHeader
            agentId={now.agentId}
            name={now.agentName}
            look={now.look}
            status={now.status}
            sessionId={sessionId}
            {...(now.elsewhere ? { readOnly: { platform: now.elsewhere } } : {})}
            history={{ open: historyOpen, toggle: () => { closeNotes(); setHistoryOpen((was) => !was); } }}
            {...(workNotes.data ? { notes: { open: notesOpen, count: workNotes.data.tasks.length, toggle: () => { setHistoryOpen(false); toggleNotes(); } } } : {})}
            {...(writes ? { choice: { first, onFirst: setFirst } } : {})}
            onDelete={open.deleteOnScreen}
            deleting={open.deleting}
          />
        )
      }
      aside={(now) => (
        <>
          {sessionId && workNotes.data ? (
            <NotesPanel
              key={sessionId}
              open={notesOpen}
              sessionId={sessionId}
              notes={workNotes.data}
              error={workNotes.error}
              editable={canWrite(me.data ?? null)}
              onClose={closeNotes}
            />
          ) : null}

          {now.room ? null : <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} agentId={now.agentId} agentName={now.agentName} current={sessionId} list={data.list.data} />}
        </>
      )}
    />
  );
}
