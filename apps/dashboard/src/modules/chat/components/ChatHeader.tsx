/**
 * The bar across the top: history, which agent this conversation belongs to, and the two ways to
 * start a new one.
 *
 * Extracted from `index.page.tsx` with the composer. What is left in the page is the part that is
 * genuinely about *this* conversation — its data, its scroll position, what happens on send.
 *
 * The agent control has two forms and the difference is the whole reason it is worth its own
 * component: in a new chat it is a picker, and in an existing one it is a **locked label**. A session
 * is keyed on its agent, so choosing another never changed the conversation on screen — it navigated
 * to a different one — and a dropdown that looked like "switch persona" was promising something it
 * could not do.
 */

import { Check, ChevronDown, Crown, Lock, NotebookPen, PanelLeft, Plus, Trash2 } from "lucide-react";
import type { AgentSummary, Room } from "@/commons/lib/api";
import { agentModel } from "@/commons/lib/agents";
import { useConfirm } from "@/commons/components/ui/confirm";
import { NewRoomButton } from "./NewRoom.tsx";
import { RoomBar } from "./RoomBar.tsx";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";

export interface ChatHeaderProps {
  historyOpen: boolean;
  toggleHistory: () => void;
  /** What the daemon holds, not what is on screen — the badge used to read the page size. */
  totalSessions: number;
  /** Set for a room; a room has members rather than one agent, so the picker is hidden. */
  room: Room | null;
  /** Set once the conversation exists, which is what locks the agent. */
  sessionId: string | undefined;
  agents: AgentSummary[];
  currentAgent: AgentSummary | undefined;
  /** The daemon's default, crowned in the list so the ordering is explained rather than inferred. */
  orchestrator: string | undefined;
  pickAgent: (agentId: string) => void;
  newChat: () => void;
  /** Deletes the conversation on screen. Offered only for a one-to-one chat; a room has its own. */
  onDelete: () => void;
  deleting: boolean;
  /**
   * The work notes drawer's toggle, with how many tasks they hold. Absent where there are none to show: a new chat, a
   * room — a session per member — or a daemon that keeps none.
   */
  notes?: { open: boolean; count: number; toggle: () => void };
}

export function ChatHeader({
  historyOpen,
  toggleHistory,
  totalSessions,
  room,
  sessionId,
  agents,
  currentAgent,
  orchestrator,
  pickAgent,
  newChat,
  onDelete,
  deleting,
  notes,
}: ChatHeaderProps) {
  const { ask, dialog } = useConfirm();
  return (
  <header className="h-14 px-4 sm:px-6 border-b border-base-content/[0.08] bg-base-100/80 backdrop-blur-xl flex items-center justify-between gap-3 shrink-0 z-20">
    {/* `min-w-0`, so a room's long name is cut here rather than pushing New Chat and New Room off a phone's screen. */}
    <div className="flex min-w-0 items-center gap-2.5">
      <button
        type="button"
        className={`btn btn-ghost btn-xs h-8 px-2.5 rounded-xl gap-1.5 font-medium transition-all ${
          historyOpen ? "bg-base-200 text-base-content" : "text-base-content/70 hover:text-base-content"
        }`}
        onClick={toggleHistory}
        aria-expanded={historyOpen}
        aria-label={totalSessions > 0 ? `History, ${totalSessions} ${totalSessions === 1 ? "conversation" : "conversations"}` : "History"}
        title="Show or hide past conversations"
      >
        <PanelLeft size={16} aria-hidden="true" />
        <span className="text-xs hidden sm:inline">History</span>
        {totalSessions > 0 && (
          <span className="badge badge-xs badge-ghost px-1.5 font-mono text-[10px]">
            {totalSessions}
          </span>
        )}
      </button>

      <div className="h-4 w-px bg-base-content/10 hidden sm:block" />

      {/*
        A room shows what it is and who is in it; a one-to-one chat shows the agent picker.
        Not both: in a room nobody is selected — the person chooses who they are talking to by
        tagging them — and a picker beside that would suggest a "current agent" the router has
        no concept of.
      */}
      {room ? <RoomBar room={room} /> : null}
      {/*
        A conversation that exists belongs to its agent, so the picker is a label there.

        Switching never changed *this* conversation — a session is keyed on its agent, so picking
        another one navigated to a brand-new chat. Offering a "Switch Agent Persona" menu inside
        an existing conversation therefore promised something it could not do, and the honest
        place to start a conversation with somebody else is the New Chat button next to it.

        Open only on a fresh chat, where there is nothing yet and the choice is real.
      */}
      {sessionId ? (
        <span
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-base-200/40 border border-base-content/[0.06] text-sm font-semibold text-base-content"
          title="This conversation belongs to this agent. Use New Chat to talk to another"
        >
          <span className="truncate max-w-[130px] sm:max-w-[200px]">
            {currentAgent?.displayName || "Agent"}
          </span>
          <Lock size={11} className="text-base-content/30 shrink-0" />
        </span>
      ) : null}

      {/*
        The same delete a room has in its own bar, in the same place, for the same reason: a
        conversation you are reading is the one you most often want to be rid of, and the only way to
        do it was to open the history drawer and find the row you were already looking at.

        Confirmed, and the wording says what goes — a transcript with its turns and steps. Rooms warn
        about more because they delete more.
      */}
      {sessionId && !room ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square rounded-lg text-base-content/65 hover:text-error"
          aria-label="Delete this conversation"
          title="Delete this conversation"
          disabled={deleting}
          onClick={async () => {
            const confirmed = await ask({
              title: "Delete this conversation?",
              body: (
                <>
                  The conversation goes, with everything in it. Anything running is cancelled.
                  There is no undo.
                </>
              ),
              confirmLabel: "Delete",
            });
            if (confirmed) onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      ) : null}
      <div className={room || sessionId ? "hidden" : "contents"}>
        <DropdownMenu
          trigger={<>
            <span className="truncate max-w-[130px] sm:max-w-[200px]">
              {currentAgent?.displayName || "Select Agent"}
            </span>
            <ChevronDown size={13} className="text-base-content/40 shrink-0" />
          </>}
          triggerClassName="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-base-200/60 hover:bg-base-200 border border-base-content/[0.08] text-sm font-semibold text-base-content active:scale-95 transition-all shadow-xs"
          align="start"
          width={288}
          menuClassName="bg-base-100/95 backdrop-blur-2xl rounded-2xl border border-base-content/10 p-2 shadow-2xl space-y-1"
        >
          {(close) => <>
          <li className="menu-title text-[10px] uppercase font-bold text-base-content/65 px-2.5 py-1 font-mono">
            Switch Agent
          </li>
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => {
                  close();
                  pickAgent(agent.id);
                }}
                className={`flex items-center justify-between p-2.5 rounded-xl text-xs ${
                  agent.id === currentAgent?.id ? "bg-primary/10 text-primary font-bold" : "text-base-content/80"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold flex items-center gap-1.5">
                    {agent.displayName}
                    {/* Why this one is at the top, said rather than left to be inferred from a
                        sort order the reader cannot see. */}
                    {agent.id === orchestrator && (
                      <span className="badge badge-xs badge-ghost gap-1 font-semibold px-1.5 text-[9px] uppercase tracking-wide font-mono">
                        <Crown size={9} /> orchestrator
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] font-mono text-base-content/65 truncate mt-0.5">{agentModel(agent)}</p>
                </div>
                {agent.id === currentAgent?.id && <Check size={14} className="text-primary shrink-0" />}
              </button>
            </li>
          ))}
          </>}
        </DropdownMenu>
      </div>

      {/*
        The model, and only where there is one.

        A room has several agents on several models — the badge showed whichever one had answered
        last, so it changed under the reader between messages and named a model that had nothing
        to do with the next reply. Each agent's model is on its own row in the Agents page, which
        is where a per-agent fact belongs.
      */}
      {room ? null : (
        <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-base-200/40 border border-base-content/[0.06] text-[11px] font-mono text-base-content/65">
          <span className="size-1.5 rounded-full bg-success shrink-0" />
          <span className="truncate max-w-[200px]" title={currentAgent ? agentModel(currentAgent) : undefined}>{currentAgent ? agentModel(currentAgent) : "active"}</span>
        </span>
      )}
    </div>

    <div className="flex shrink-0 items-center gap-2">
      {/* The history toggle's twin, on the side its drawer opens from. */}
      {notes ? (
        <button
          type="button"
          className={`btn btn-ghost btn-xs h-8 px-2.5 rounded-xl gap-1.5 font-medium transition-all ${
            notes.open ? "bg-base-200 text-base-content" : "text-base-content/70 hover:text-base-content"
          }`}
          onClick={notes.toggle}
          aria-expanded={notes.open}
          aria-label={notes.count > 0 ? `Work notes, ${notes.count} ${notes.count === 1 ? "task" : "tasks"}` : "Work notes"}
          title="Show or hide the work notes"
        >
          <NotebookPen size={16} aria-hidden="true" />
          <span className="text-xs hidden sm:inline">Notes</span>
          {notes.count > 0 && (
            <span className="badge badge-xs badge-ghost px-1.5 font-mono text-[10px]">{notes.count}</span>
          )}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-xs h-8 px-3 rounded-xl gap-1.5 font-semibold text-primary hover:bg-primary/10 active:scale-95 transition-all text-xs"
        onClick={newChat}
        aria-label="New chat"
      >
        <Plus size={15} aria-hidden="true" />
        {/* A word on a phone only as History, Notes and New Room have one: four labelled buttons do not fit 375 px. */}
        <span className="hidden sm:inline">New Chat</span>
      </button>

      <NewRoomButton />
    </div>
    {dialog}
  </header>
  );
}
