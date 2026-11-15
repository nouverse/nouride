/**
 * A drawer: a panel that slides in from a side of the conversation over a shade that fades, and slides back. An agent's
 * History comes from the left and its work notes from the right, the twins of each other. A phone's sheet from the foot
 * of the screen is `Sheet`, which shares this motion and this focus, so opening any one of them looks like opening any
 * other.
 *
 * It stays drawn while closed, out of sight (`invisible`) and out of reach (`inert`), so it is seen to go as well as to
 * come; what is inside can wait for the first opening (`lazy`) and goes a moment after it closes. Escape closes it; it
 * takes the focus as it opens — its first field from a tablet's width up, the panel itself on a phone, where a field
 * would bring the keyboard up over it — and gives it back to whatever had it.
 *
 * It is placed in its parent, which is `relative`: the conversation's pane, under its bar. It is a panel beside the
 * conversation (`<aside>`), as History and the notes always were, not a dialog: the page around it stays where it was,
 * and a phone's checks read it as no card of the page. It is not drawn and undrawn by its page, so it needs no
 * `Leaving`: it is always drawn, and moves.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { useWide } from "@/commons/hooks/use-wide";
import { cn } from "@/commons/lib/utils";

/** How long a drawer takes to come and go, and how; the shade fades in the same time. */
export const MOTION_MS = 200;
export const DRAWER_MOTION = "transition-[translate,visibility] duration-200 ease-out";
/** The shade under an open drawer. */
export const DRAWER_SHADE = "bg-black/40 transition-[opacity,visibility] duration-200 ease-out";
/**
 * Put away, it takes no tap from the moment it starts to go, not only once it is hidden: it
 * stays visible for the 200 ms it slides, and a tap in that time landed on whatever of it was passing under the finger.
 * A phone's More slid down over the tab bar, and a quick tap on a tab opened a page from the menu instead.
 */
export const GONE = "invisible pointer-events-none";
export const SHADE_PLACE = { open: "visible opacity-100", closed: `${GONE} opacity-0` } as const;

const SIDES = {
  // A phone keeps a strip of the conversation beside it: a tap there closes it, and it reads as over the chat.
  left: { box: "inset-y-0 left-0 w-[min(24rem,calc(100%-2.5rem))] border-r border-base-content/[0.08] bg-base-100 shadow-xl", open: "visible translate-x-0", closed: `${GONE} -translate-x-full` },
  right: { box: "inset-y-0 right-0 w-[min(24rem,calc(100%-2.5rem))] border-l border-base-content/[0.08] bg-base-100 shadow-xl", open: "visible translate-x-0", closed: `${GONE} translate-x-full` },
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

  useOpenFocus(open, panel, onClose, wide);

  const place = SIDES[side];
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${label}`}
        onClick={onClose}
        className={cn("absolute inset-0 z-20", DRAWER_SHADE, open ? SHADE_PLACE.open : SHADE_PLACE.closed)}
      />
      <aside
        ref={panel}
        aria-label={label}
        tabIndex={-1}
        inert={!open}
        data-drawer={side}
        data-open={open ? "" : undefined}
        className={cn("absolute z-30 flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] outline-none", place.box, DRAWER_MOTION, open ? place.open : place.closed, className)}
      >
        {drawn ? children : null}
      </aside>
    </>
  );
}

/**
 * While a drawer or a sheet is open: Escape closes it, it takes the focus — its first field when `field`, else the
 * panel itself — and as it closes it gives the focus back to whatever had it.
 */
export function useOpenFocus(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void, field: boolean): void {
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement as HTMLElement | null;
    // Visible from the frame it opens in (visibility turns on at once and off only at the end), so it can take it now.
    const first = field ? panel.current?.querySelector<HTMLElement>("input, textarea, button, a[href]") : null;
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
