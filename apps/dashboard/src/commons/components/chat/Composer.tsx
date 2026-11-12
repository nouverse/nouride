/**
 * Everything below the transcript: the box, its two completion menus, and the send button.
 *
 * Extracted from `index.page.tsx`, which was 986 lines with thirty pieces of state in one function
 * body — every feature that touched the chat had to edit that file, and the two completion menus'
 * keyboard handling had already been written twice inside it.
 *
 * ## Why the props are grouped rather than flat
 *
 * This block reads twenty-one identifiers from its parent. Passed one by one that is a signature
 * nobody can read and a call nobody can check; grouped, it says what the composer is made of — the
 * text being typed, two menus, some files, and the conversation it is speaking into. The grouping is
 * the honest shape of the entanglement rather than a way of hiding it.
 */

import type { RefObject } from "react";
import { Send, Square, SquareSlash } from "lucide-react";
import type { Room, SlashCommand } from "@nouride/wire";
import type { Conversation } from "@/commons/hooks/use-conversation";
import { AttachButton, AttachmentTray, type AttachedFile } from "@/commons/components/ui/FileDrop";
import { ErrorNote } from "@/commons/components/ui/ui";
import { MentionMenu, type MentionCandidate } from "./MentionMenu.tsx";
import { SlashMenu } from "./SlashMenu.tsx";
import { completionKey } from "@/commons/lib/completion";

/** One completion menu, from the composer's point of view. */
export interface MenuState<T> {
  matches: T[];
  active: number;
  setActive: (index: number) => void;
  pick: (item: T) => void;
  /** Escape, a click away, or a pick: whatever means "not now". */
  close: () => void;
  /**
   * A keystroke arrived, so a previous dismissal no longer applies.
   *
   * The opposite of `close`, and needed as its own callback rather than reusing it: a new keystroke
   * is a new token, and Escape's "not now" must not outlive the thing it was about.
   */
  onTyped: () => void;
}

export interface ComposerProps {
  input: string;
  setInput: (next: string) => void;
  submit: () => void;
  canSend: boolean;
  /** False for a conversation that happened on another gateway — readable, not writable. */
  writable: boolean;
  busy: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  room: Room | null;
  agentName: string | undefined;
  /** In a room, who answers a message that tags nobody, in words (`untaggedWords`). */
  untaggedHint?: string | undefined;
  slash: MenuState<SlashCommand> & { open: boolean; toggle: () => void };
  mention: MenuState<MentionCandidate> & { index: number };
  attachments: {
    files: AttachedFile[];
    add: (files: File[]) => void;
    remove: (id: string) => void;
    uploading: boolean;
  };
  /**
   * The live conversation, narrowed to what the composer reads: the error to show above the box, the
   * gateway a read-only transcript belongs to, and the stop button's action.
   *
   * `Pick` rather than a restated shape — the first version wrote `error?: string` and the compiler
   * pointed out it is an `Error`, which is the kind of guess a hand-copied prop type invites.
   */
  conversation: Pick<Conversation, "error" | "session" | "stop">;
}

export function Composer(props: ComposerProps) {
  const {
    input,
    setInput,
    submit,
    canSend,
    writable,
    busy,
    textareaRef,
    room,
    agentName,
    untaggedHint,
    attachments,
    conversation,
  } = props;
  const mentionMatches = props.mention.matches;
  const mentionActive = props.mention.active;
  const mentionIndex = props.mention.index;
  const setMentionActive = props.mention.setActive;
  const slashMatches = props.slash.matches;
  const slashActive = props.slash.active;
  const setSlashActive = props.slash.setActive;
  const slashOpen = props.slash.open;
  const toggleSlash = props.slash.toggle;
  const closeSlash = props.slash.close;
  const pickCommand = props.slash.pick;
  const pickMention = (agentId: string) => {
    const candidate = mentionMatches.find((item) => item.agentId === agentId);
    if (candidate) props.mention.pick(candidate);
  };
  const setMentionDismissed = (dismissed: boolean) => {
    if (dismissed) props.mention.close();
  };
  const currentAgent = agentName ? { displayName: agentName } : undefined;

  return (
    // Its bottom clear of a phone's home indicator (the safe area, `viewport-fit=cover`): 0 on a desktop.
    <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))] bg-base-100/90 backdrop-blur-xl border-t border-base-content/[0.08] shrink-0 mt-auto">
      <div className="max-w-3xl mx-auto space-y-2">
        <ErrorNote error={conversation.error} />

        <AttachmentTray files={attachments.files} onRemove={attachments.remove} />

        <div className="relative flex items-end gap-1 bg-base-200/60 border border-base-content/[0.12] focus-within:border-primary/50 focus-within:bg-base-100 focus-within:ring-4 focus-within:ring-primary/10 rounded-3xl p-2 sm:p-2.5 shadow-sm transition-all">
          <MentionMenu
            candidates={mentionMatches}
            active={mentionIndex}
            onPick={pickMention}
            onHover={setMentionActive}
          />
          <SlashMenu
            commands={slashMatches}
            active={slashActive}
            onPick={pickCommand}
            onHover={setSlashActive}
          />
          <AttachButton onFiles={attachments.add} disabled={!writable} />
          <button aria-hidden="true"
            type="button"
            title="Commands that start with /: answered by Nouride itself, with no AI call"
            aria-label="Slash commands"
            aria-expanded={slashOpen}
            disabled={!writable}
            // Focus stays in the textarea, so the blur below does not close the menu a moment
            // before this click opens it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleSlash}
            // An icon the size and colour of the paperclip beside it: a "/" set in bold mono leaned and sat
            // lower than every other control in the row.
            className={`btn btn-ghost btn-sm btn-circle shrink-0 disabled:opacity-30 mb-1 ${
              slashOpen
                ? "bg-primary/10 text-primary"
                : "text-base-content/65 hover:text-base-content"
            }`}
          >
            <SquareSlash size={16} />
          </button>
          <textarea
            ref={textareaRef}
            // One line is 40px, its text centred on the 20px the 32px buttons beside it centre on (`mb-1`): at 42px
            // with a 1.625 line height the text sat 5px above the icons.
            className="w-full bg-transparent border-0 resize-none max-h-40 min-h-10 px-3 py-[9px] text-sm leading-[22px] text-base-content placeholder:text-base-content/65 max-sm:placeholder:truncate focus:outline-none disabled:opacity-50"
            /*
              One line of it on a phone, cut with an ellipsis: at the 16px a phone's field is, it wrapped to a second line
              the one-row box cut in half.

              A room has no current agent to name. "Message Nero…" in a room is a lie the page
              told because it derived a name from whichever agent answered last — so it changed
              under the reader between messages, and suggested that typing here reached that one.
            */
            placeholder={
              !writable
                ? "Read-only: this conversation belongs to another chat app"
                : room
                  ? "Message the room"
                  : `Message ${currentAgent?.displayName || "agent"}…`
            }
            rows={1}
            disabled={!writable}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // A new keystroke is a new question, so Escape's dismissal does not outlive the
              // token it was about — but leaving `/status ` still keeps the menu shut, because
              // there is no token left to match.
              props.slash.onTyped();
              // Back to the top: the list has just been refiltered by the keystroke, so a
              // highlight held over from the old list would point at a different name.
              props.mention.onTyped();
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              /**
               * The mention menu first, because the two cannot both be open: a slash command is
               * the first word and a mention is at the caret. Ordered anyway rather than left to
               * chance — `/model @nero` is a real thing to type, and there the mention is what
               * is being completed.
               *
               * Both menus share `completionKey`, which used to be these eighty-five lines
               * twice. The one difference between them is `startAt`, and it is the interesting
               * one: the slash menu starts unhighlighted so Enter still *sends* `/status`.
               */
              const mention = completionKey({
                event: e,
                count: mentionMatches.length,
                active: mentionActive,
                startAt: 0,
              });
              if (mention) {
                e.preventDefault();
                if (mention.kind === "move") setMentionActive(mention.to);
                else if (mention.kind === "dismiss") {
                  setMentionDismissed(true);
                  setMentionActive(0);
                } else pickMention(mentionMatches[mention.index]!.agentId);
                return;
              }

              const slash = completionKey({
                event: e,
                count: slashMatches.length,
                active: slashActive,
                startAt: -1,
              });
              if (slash) {
                e.preventDefault();
                if (slash.kind === "move") setSlashActive(slash.to);
                else if (slash.kind === "dismiss") closeSlash();
                else pickCommand(slashMatches[slash.index] as SlashCommand);
                return;
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              // A screenshot on the clipboard is the most common attachment there is, and the
              // browser offers it here as a file. Text pastes are left alone.
              const pasted = [...e.clipboardData.files];
              if (pasted.length > 0) {
                e.preventDefault();
                attachments.add(pasted);
              }
            }}
            // Clicking away closes it. The menu's own rows hold the focus themselves, so this
            // fires for everything except choosing one — which is exactly the set that means
            // "not now".
            onBlur={() => {
              closeSlash();
              setMentionDismissed(true);
              setMentionActive(0);
            }}
          />

          {/*
            Send stays while an agent works, with a stop *beside* it.

            In a room the other members are free, and the composer refusing input was the thing that
            made a room feel broken — a question for Nero could not be typed because Nouva was reading
            a web page. In a one-to-one chat there is now something to say too: a message sent while
            the agent works is read by its turn at the next step (steering), so swapping send for stop
            there would hide the one way to change course without stopping.
          */}
          {busy ? (
            <button
              type="button"
              onClick={() => conversation.stop()}
              className={
                room
                  ? "btn btn-ghost btn-sm btn-circle shrink-0 text-error active:scale-90 transition-all mb-1"
                  : "btn btn-error btn-sm btn-circle shrink-0 shadow-md active:scale-90 transition-all mb-1"
              }
              title={room ? "Stop what is running in this room" : "Stop generation"}
              aria-label="Stop what is running"
            >
              <Square size={room ? 13 : 14} className="fill-current" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={submit}
            title={attachments.uploading ? "waiting for the upload to finish" : busy && !room ? "Send: read before its next step" : "Send"}
            disabled={!canSend}
            className="btn btn-primary btn-sm btn-circle shrink-0 shadow-md shadow-primary/25 active:scale-90 transition-all disabled:opacity-30 mb-1"
            aria-label="Send message"
          >
            <Send size={14} />
          </button>
        </div>

        <div className="flex min-h-4 items-center justify-between gap-3 px-2 text-[11px] text-base-content/65">
          {/* In a room, who answers a message that tags nobody: the router's own answer, never a guess. */}
          <span className="min-w-0 truncate">{room ? untaggedHint : null}</span>
          {/* The keys, out of the placeholder: there they ran on past the box and read as part of the message. */}
          {writable && <span className="hidden shrink-0 sm:inline">Enter to send · Shift+Enter for a new line</span>}
        </div>
      </div>
    </div>
  );
}
