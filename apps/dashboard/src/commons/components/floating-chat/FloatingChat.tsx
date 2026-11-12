/**
 * The chat that floats over every page but Chats: a button at the foot of the window with an agent's face on it, and
 * the panel it opens, so a person can ask an agent about what they are looking at without leaving the page. From a
 * tablet's width up the panel is a card over the button, and the page under it stays in reach; on a phone it is a sheet
 * over the page (`Drawer`). Pressing the button again, Escape or the panel's own minimize puts it away.
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
import { FloatingPanel, type Started } from "./FloatingPanel";

/** Where this browser keeps the agent the floating chat was last on. */
const LAST_AGENT_KEY = "nouride-floating-chat-agent";
const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Where the button stands, 3.5rem across: it was 2.75rem in the corner, and too small to find or to hit. Below a
 * laptop's width: over the tab bar, clear of it, where Home's "+ Chat" stood. From a laptop up: in the window's corner,
 * 1rem in. Every page's foot leaves it room (`PAGE_BOTTOM`), a page held to the window too, so it lies over no card.
 */
const BUTTON_PLACE = "right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] size-14 lg:bottom-4";

/** The card, from a tablet's width up: over the button, about 400 by 620, and never taller than the window. */
const CARD_PLACE =
  "right-4 bottom-[calc(9.5rem+env(safe-area-inset-bottom))] h-[38.75rem] max-h-[calc(100dvh-10.5rem-env(safe-area-inset-bottom))] w-[25rem] max-w-[calc(100vw-2rem)] lg:bottom-20 lg:max-h-[calc(100dvh-6rem)]";

export function FloatingChat({ pathname }: { pathname: string }) {
  const me = useMe();
  const chat = useChatAgents();
  const state = useFloatingChat();
  const wide = useWide();
  const [last, setLast] = useKept(LAST_AGENT_KEY, "", isString);
  /** What is written in the box and not sent: kept here, so putting the panel away does not throw it away. */
  const box = useState("");
  /** The conversations a first message in the panel started, by agent: kept here for the same reason (`FloatingPanel`). */
  const started = useState<Record<string, Started>>({});
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
  const panel = <FloatingPanel agentId={state.agent} chat={chat} box={box} started={started} draft={state.draft} focusBox={wide} onClose={closeFloatingChat} />;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={state.open}
        aria-label={state.open ? `Minimize the chat with ${name}` : label}
        title={state.open ? "Minimize the chat" : label}
        onClick={() => (state.open ? closeFloatingChat() : openFloatingChat({ agent: opensOn }))}
        className={cn(
          "fixed z-30 grid place-items-center rounded-full border border-base-content/[0.08] bg-base-100 text-secondary shadow-soft transition-transform duration-150 hover:-translate-y-0.5 active:scale-95",
          BUTTON_PLACE,
        )}
      >
        {look ? (
          <>
            <AgentAvatar look={look} name={name} size="xs" className="size-11 rounded-full" />
            {/* The face says who; the mark on its corner says what the button is. */}
            <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full bg-secondary text-secondary-content ring-2 ring-base-100">
              <MessageCircle size={13} />
            </span>
          </>
        ) : (
          <MessageCircle size={24} aria-hidden="true" />
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
    // What had the focus before it opened: the button most often, in a browser that focuses a button it is pressed with.
    const at = document.activeElement as HTMLElement | null;
    const before = at && !box.current?.contains(at) ? at : null;
    // The box to write in, where the conversation is drawn already (from what was read last); else the card itself,
    // and the box once the conversation is drawn (`FloatingPanel`).
    (box.current?.querySelector<HTMLElement>("textarea:not(:disabled)") ?? box.current)?.focus();
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
