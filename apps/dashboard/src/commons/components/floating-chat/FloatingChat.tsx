/**
 * The chat that floats over every page but Chats: a button at the foot of the window with an agent's face on it, and
 * the panel it opens, so a person can ask an agent about what they are looking at without leaving the page. From a
 * tablet's width up the panel is a card over the button, and the page under it stays in reach; on a phone it is a sheet
 * over the page (`Drawer`). Pressing the button again, Escape or the panel's own close puts it away.
 *
 * Which agent it opens on is `agentAtOpen`'s to say: the one the page belongs to, else the one it was last on in this
 * browser, else the orchestrator. The person picks another in the panel's bar.
 *
 * Not for an account that may only read (a viewer sends nothing), and not drawn by the shell on Chats, where the
 * conversation is the page. Closed, it draws no conversation: nothing is asked of the daemon and no stream is held.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { MessageCircle } from "lucide-react";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { Drawer } from "@/commons/components/ui/Drawer";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { useChatAgents } from "@/commons/hooks/use-chat-agents";
import { useKept } from "@/commons/hooks/use-kept";
import { useWide } from "@/commons/hooks/use-wide";
import { agentAtOpen, agentOfPage, closeFloatingChat, openFloatingChat, useFloatingChat } from "@/commons/lib/floating-chat";
import { canWrite, useMe } from "@/commons/lib/session";
import { cn } from "@/commons/lib/utils";
import { FloatingPanel } from "./FloatingPanel";

/** Where this browser keeps the agent the floating chat was last on. */
const LAST_AGENT_KEY = "nouride-floating-chat-agent";
const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Where the button stands. Below a laptop's width: over the tab bar, clear of it, where Home's "+ Chat" stood, and a
 * page's foot leaves it room (`PAGE_BOTTOM`). From a laptop up: in the window's corner, small enough that of a card held
 * to the window (`HELD_BOTTOM`) it lies over the rounded corner and nothing in it.
 */
const BUTTON_PLACE = "right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] size-12 lg:right-2.5 lg:bottom-2.5 lg:size-11";

/** The card, from a tablet's width up: over the button, about 400 by 620, and never taller than the window. */
const CARD_PLACE =
  "right-4 bottom-[calc(9rem+env(safe-area-inset-bottom))] h-[38.75rem] max-h-[calc(100dvh-10rem-env(safe-area-inset-bottom))] w-[25rem] max-w-[calc(100vw-2rem)] lg:right-2.5 lg:bottom-16 lg:max-h-[calc(100dvh-5rem)]";

export function FloatingChat({ pathname }: { pathname: string }) {
  const me = useMe();
  const chat = useChatAgents();
  const state = useFloatingChat();
  const wide = useWide();
  const [last, setLast] = useKept(LAST_AGENT_KEY, "", isString);
  /** What is written in the box and not sent: kept here, so putting the panel away does not throw it away. */
  const box = useState("");
  const button = useRef<HTMLButtonElement>(null);

  // Gone with the shell around it (Chats, a sign-out): closed, so it is not open again on the page after.
  useEffect(() => closeFloatingChat, []);
  // On a phone it is a sheet over the page: a page opened from inside it is then seen, not left under it.
  useEffect(() => {
    if (!wide) closeFloatingChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a navigation, not on a window turned or resized
  }, [pathname]);
  // The agent it is on is the one it opens on next time, in this browser.
  useEffect(() => {
    if (state.open && state.agent) setLast(state.agent);
  }, [state.open, state.agent, setLast]);

  if (!canWrite(me.data ?? null) || chat.agents.length === 0) return null;

  const opensOn = agentAtOpen({ page: agentOfPage(pathname), last, orchestrator: chat.orchestrator, agents: chat.agents });
  const shown = state.open ? state.agent : opensOn;
  const name = chat.nameOf(shown);
  const look = chat.looks.get(shown);
  const label = `Chat with ${name}`;
  const panel = <FloatingPanel agentId={state.agent} chat={chat} box={box} draft={state.draft} focusBox={wide} onClose={closeFloatingChat} />;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={state.open}
        aria-label={state.open ? `Close the chat with ${name}` : label}
        title={state.open ? "Close the chat" : label}
        onClick={() => (state.open ? closeFloatingChat() : openFloatingChat({ agent: opensOn }))}
        className={cn(
          "fixed z-30 grid place-items-center rounded-full border border-base-content/[0.08] bg-base-100 text-secondary shadow-soft transition-transform duration-150 hover:-translate-y-0.5 active:scale-95",
          BUTTON_PLACE,
        )}
      >
        {look ? (
          <>
            <AgentAvatar look={look} name={name} size="xs" className="size-9 rounded-full lg:size-8" />
            {/* The face says who; the mark on its corner says what the button is. */}
            <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full bg-secondary text-secondary-content ring-2 ring-base-100">
              <MessageCircle size={11} />
            </span>
          </>
        ) : (
          <MessageCircle size={20} aria-hidden="true" />
        )}
      </button>

      {wide ? (
        <Leaving value={state.open}>
          {() => (
            <FloatingCard open={state.open} label={label} button={button} onClose={closeFloatingChat}>
              {panel}
            </FloatingCard>
          )}
        </Leaving>
      ) : (
        <Drawer open={state.open} onClose={closeFloatingChat} side="bottom" label={label} lazy className="h-[85dvh] bg-base-100 pb-0">
          <span aria-hidden="true" className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-base-content/20" />
          {panel}
        </Drawer>
      )}
    </>
  );
}

/** Whether a dialog other than `card` is open over the page: a picture opened from the chat, a question, a preview. */
function dialogOver(card: HTMLElement | null): boolean {
  return [...document.querySelectorAll('[role="dialog"], dialog[open]')].some((one) => one !== card && !one.closest("[inert]"));
}

/**
 * The panel as a card over the button, drawn at the body (`overPage`) and through `Leaving`, so it is seen to go. Not a
 * dialog that takes the page away: nothing is shaded and a press outside it closes nothing, since the page under it is
 * what the person is asking about. It takes the focus as it opens and gives it back to whatever had it, the button
 * most often, as it closes.
 */
function FloatingCard({ open, label, button, onClose, children }: { open: boolean; label: string; button: RefObject<HTMLButtonElement | null>; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement as HTMLElement | null;
    // The card now, and the box to write in once the conversation is drawn (`FloatingPanel`).
    box.current?.focus();
    const escape = (event: KeyboardEvent) => {
      // One a menu of the box took (`Composer`) is not the card's; nor one for a picture or a question open over the
      // page, which closes first, by its own; nor one pressed in a field of the page under it.
      if (event.key !== "Escape" || event.defaultPrevented || dialogOver(box.current)) return;
      const at = document.activeElement;
      if (!at || at === document.body || box.current?.contains(at) || button.current?.contains(at)) onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      // Back to whatever had it, when the focus was still in here: not when it had moved on by itself. To the button
      // where nothing had it: a browser that does not focus a button it is pressed with.
      const inside = box.current?.contains(document.activeElement) || document.activeElement === document.body;
      if (inside) (before && before !== document.body && before.isConnected ? before : button.current)?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; `onClose` is read when it fires
  }, [open]);

  return overPage(
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-floating-chat=""
      className={cn("fixed z-40 flex origin-bottom-right flex-col overflow-hidden rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft outline-none animate-enter", CARD_PLACE)}
    >
      {children}
    </div>,
  );
}
