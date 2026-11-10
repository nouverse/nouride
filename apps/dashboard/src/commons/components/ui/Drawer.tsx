/**
 * A drawer: a panel that slides in from an edge over a shade that fades, and slides back. An agent's History comes from
 * the left of the conversation and its work notes from the right, the twins of each other; on a phone a sheet rises
 * from the foot of the screen (the + menu, and the app's More, which shares its classes below). One motion for all of
 * them, so opening any one of them looks like opening any other.
 *
 * It stays drawn while closed, out of sight (`invisible`) and out of reach (`inert`), so it is seen to go as well as to
 * come; what is inside can wait for the first opening (`lazy`) and goes a moment after it closes. Escape closes it; it
 * takes the focus as it opens — its first field from a tablet's width up, the panel itself on a phone, where a field
 * would bring the keyboard up over it — and gives it back to whatever had it.
 *
 * A side drawer is placed in its parent, which is `relative`: the conversation's pane, under its bar. It is a panel
 * beside the conversation (`<aside>`), as History and the notes always were, not a dialog: the page around it stays
 * where it was, and a phone's checks read it as no card of the page. A sheet is a dialog, drawn at the body, where no
 * card's glass can hold a `fixed` box inside it (`OverPage`). Neither is drawn and undrawn by its page, so neither
 * needs `Leaving`: each is always drawn, and moves.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useWide } from "@/commons/hooks/use-wide";
import { cn } from "@/commons/lib/utils";

/** How long a drawer takes to come and go, and how; the shade fades in the same time. */
const MOTION_MS = 200;
export const DRAWER_MOTION = "transition-[translate,visibility] duration-200 ease-out";
/** The shade under an open drawer. */
export const DRAWER_SHADE = "bg-black/40 transition-[opacity,visibility] duration-200 ease-out";
/** A sheet from the foot of a phone: its corners, its ground, and the room it leaves the home bar. */
export const SHEET_BOX = "max-h-[85dvh] rounded-t-[22px] bg-base-200 pb-[env(safe-area-inset-bottom)] shadow-soft";
/** Open or put away, along the edge it comes from. */
export const SHEET_PLACE = { open: "visible translate-y-0", closed: "invisible translate-y-full" } as const;
export const SHADE_PLACE = { open: "visible opacity-100", closed: "invisible opacity-0" } as const;

const SIDES = {
  // A phone keeps a strip of the conversation beside it: a tap there closes it, and it reads as over the chat.
  left: { box: "inset-y-0 left-0 w-[min(24rem,calc(100%-2.5rem))] border-r border-base-content/[0.08] bg-base-100 shadow-xl", open: "visible translate-x-0", closed: "invisible -translate-x-full" },
  right: { box: "inset-y-0 right-0 w-[min(24rem,calc(100%-2.5rem))] border-l border-base-content/[0.08] bg-base-100 shadow-xl", open: "visible translate-x-0", closed: "invisible translate-x-full" },
  bottom: { box: cn("inset-x-0 bottom-0", SHEET_BOX), ...SHEET_PLACE },
} as const;

export function Drawer({
  open,
  onClose,
  side,
  label,
  lazy = false,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side: keyof typeof SIDES;
  /** What it is, for whoever cannot see it slide in. */
  label: string;
  /** Draw what is inside only once opened, and let it go after it closes: a list that asks the daemon for a page. */
  lazy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const wide = useWide();
  const panel = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(open || !lazy);

  useEffect(() => {
    if (open) {
      setDrawn(true);
      return undefined;
    }
    if (!lazy) return undefined;
    const gone = setTimeout(() => setDrawn(false), MOTION_MS);
    return () => clearTimeout(gone);
  }, [open, lazy]);

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement as HTMLElement | null;
    // Visible from the frame it opens in (visibility turns on at once and off only at the end), so it can take it now.
    const first = wide ? panel.current?.querySelector<HTMLElement>("input, textarea, button, a[href]") : null;
    (first ?? panel.current)?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      // Back to whatever had it, when the focus was still in here: not when it had moved on by itself.
      const inside = panel.current?.contains(document.activeElement) || document.activeElement === document.body;
      if (inside && before?.isConnected) before.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; `onClose` is read when it fires
  }, [open]);

  const place = SIDES[side];
  const sheet = side === "bottom";
  const Panel = sheet ? "div" : "aside";
  const drawer = (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${label}`}
        onClick={onClose}
        className={cn(sheet ? "fixed z-40" : "absolute z-20", "inset-0", DRAWER_SHADE, open ? SHADE_PLACE.open : SHADE_PLACE.closed)}
      />
      <Panel
        ref={panel}
        {...(sheet ? { role: "dialog" } : {})}
        aria-label={label}
        tabIndex={-1}
        inert={!open}
        data-drawer={side}
        data-open={open ? "" : undefined}
        className={cn(sheet ? "fixed z-50" : "absolute z-30 pb-[env(safe-area-inset-bottom)]", "flex flex-col overflow-hidden outline-none", place.box, DRAWER_MOTION, open ? place.open : place.closed, className)}
      >
        {drawn ? children : null}
      </Panel>
    </>
  );
  return sheet ? createPortal(drawer, document.body) : drawer;
}

/** A side drawer's head: its title, what can be done to what is in it, and its close — the same in each, so they are twins. */
export function DrawerHead({ title, closeLabel, onClose, children }: { title: ReactNode; closeLabel: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
      <h2 className="min-w-0 flex-1 truncate font-display text-lg font-medium tracking-tight">{title}</h2>
      {children}
      <button type="button" className="btn btn-ghost btn-square size-9 rounded-[12px] text-base-content/65 hover:text-base-content max-sm:size-11" onClick={onClose} aria-label={closeLabel}>
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
