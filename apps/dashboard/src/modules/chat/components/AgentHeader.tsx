/**
 * The bar over a conversation with one agent: its cat, its name, what it is doing now, its History, a new chat with it,
 * the work notes in a menu where there are some, and Delete, at the end of the bar where a person looks for it. On a phone a way back to the list comes first, and the
 * buttons keep their icons only, each a finger's size and named for whoever cannot see it.
 *
 * A private chat on a chat app says where it lives and that it is read here: its app's mark on the cat, and the words
 * beside the name.
 */

import { Link } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, History, NotebookPen, Plus, Trash2 } from "lucide-react";
import type { Look } from "@/commons/cat/look";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { useConfirm } from "@/commons/components/ui/confirm";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { platformName } from "@/commons/lib/platform";
import { cn } from "@/commons/lib/utils";

/** A header's button: a word beside its icon from a phone's width up, the icon alone on a phone. */
export const HEADER_BUTTON = "btn btn-ghost h-11 min-h-11 gap-1.5 rounded-[14px] px-3 text-[13px] font-semibold text-base-content/80 hover:bg-base-content/[0.06] max-sm:w-11 max-sm:px-0 sm:h-9 sm:min-h-9";

const TONES = { working: "text-success", success: "text-base-content/65", accent: "text-accent", muted: "text-base-content/65" } as const;

export function AgentHeader({
  agentId,
  name,
  look,
  status,
  sessionId,
  readOnly,
  history,
  notes,
  onDelete,
  deleting,
}: {
  agentId: string;
  name: string;
  look: Look | undefined;
  /** What it is doing, and a longer tail of it for where there is room ("in the background"). */
  status: { words: string; more?: string; tone: keyof typeof TONES };
  sessionId: string | undefined;
  /** A private chat on a chat app: read here, answered there. */
  readOnly?: { platform: string };
  /** History's drawer, drawn by the conversation's pane under this bar; its toggle is here. */
  history: { open: boolean; toggle: () => void };
  /** The work notes drawer's toggle; absent where there are none to show. */
  notes?: { open: boolean; count: number; toggle: () => void };
  onDelete: () => void;
  deleting: boolean;
}) {
  const { ask, dialog } = useConfirm();

  return (
    <header className="z-20 flex h-[4.25rem] shrink-0 items-center gap-1.5 border-b border-base-content/[0.08] bg-base-100/80 px-2 backdrop-blur-xl sm:gap-2.5 sm:px-5">
      <Link to="/chat" className="btn btn-ghost btn-square size-11 shrink-0 rounded-[14px] md:hidden" aria-label="Back to chats">
        <ChevronLeft size={22} aria-hidden="true" />
      </Link>
      {look ? <AgentAvatar look={look} name={name} size="sm" {...(readOnly ? { platform: readOnly.platform } : {})} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate font-display text-lg font-medium tracking-tight text-base-content">{name}</h2>
          {readOnly ? (
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <PlatformTag>{`${platformName(readOnly.platform)} chat`}</PlatformTag>
              <PlatformTag>Read-only</PlatformTag>
            </span>
          ) : null}
        </div>
        <p className={cn("truncate text-xs font-semibold", TONES[status.tone])}>
          {readOnly ? <span className="sm:hidden">Read-only · {platformName(readOnly.platform)}</span> : null}
          <span className={readOnly ? "max-sm:hidden" : undefined}>
            {status.words}
            {status.more ? <span className="max-sm:hidden">{status.more}</span> : null}
          </span>
        </p>
      </div>

      <button type="button" className={cn(HEADER_BUTTON, history.open && "bg-secondary/10 text-secondary")} aria-expanded={history.open} aria-label={`${name}'s conversations`} onClick={history.toggle}>
        <History size={17} aria-hidden="true" />
        <span className="max-sm:hidden">History</span>
      </button>
      <Link to="/chat" search={{ agent: agentId }} className={HEADER_BUTTON} aria-label={`New chat with ${name}`}>
        <Plus size={17} aria-hidden="true" />
        <span className="max-sm:hidden">New chat</span>
      </Link>
      {notes ? (
        <DropdownMenu
          trigger={<Ellipsis size={17} aria-hidden="true" />}
          triggerClassName={cn(HEADER_BUTTON, "w-11 px-0 sm:w-9")}
          ariaLabel="More for this conversation"
          width={240}
          menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
        >
          {(close) => (
            <li>
              <button type="button" className="min-h-11 gap-3 rounded-xl text-sm" onClick={() => { close(); notes.toggle(); }}>
                <NotebookPen size={16} aria-hidden="true" />
                {notes.open ? "Hide work notes" : notes.count > 0 ? `Work notes · ${notes.count} ${notes.count === 1 ? "task" : "tasks"}` : "Work notes"}
              </button>
            </li>
          )}
        </DropdownMenu>
      ) : null}
      {sessionId ? (
        <button
          type="button"
          className={cn(HEADER_BUTTON, "hover:bg-error/10 hover:text-error")}
          aria-label="Delete this conversation"
          disabled={deleting}
          onClick={async () => {
            const confirmed = await ask({
              title: "Delete this conversation?",
              body: <>The conversation goes, with everything in it. Anything running is cancelled. There is no undo.</>,
              confirmLabel: "Delete",
            });
            if (confirmed) onDelete();
          }}
        >
          <Trash2 size={17} aria-hidden="true" />
          <span className="max-sm:hidden">Delete</span>
        </button>
      ) : null}

      {dialog}
    </header>
  );
}
