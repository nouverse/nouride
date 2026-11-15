/**
 * A sheet from the foot of a phone's screen: the one way a phone draws a panel over the page. "Add a step", the
 * list of agents to start a chat with, a conversation's model, the app's More, an agent's card, and the floating chat
 * are each this component (`sheets.test.ts` finds any sheet that is not).
 *
 * Its head is a grab line, its name and a button that closes it, a finger's size. It closes four ways: that button,
 * Escape, a press on the shade, and a swipe down on the head past a short distance (`swipeCloses`); a shorter drag
 * springs back. The floating chat brings a head of its own (`head={false}`), with its line to minimize where the
 * others have their close: it is the one sheet with something to put away and not to close. Its own head is still
 * where a swipe starts (`SHEET_GRAB`).
 *
 * It is a dialog drawn at the body, where no card's glass can hold a `fixed` box inside it. It stays drawn while
 * closed, out of sight and out of reach, so it is seen to go as well as to come, with the motion and the focus of every
 * drawer (`Drawer`): it takes the focus as it opens, the panel and not a field, which would bring the keyboard up over
 * it, and gives it back to what opened it as it closes.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { DRAWER_MOTION, DRAWER_SHADE, GONE, MOTION_MS, SHADE_PLACE, useOpenFocus } from "@/commons/components/ui/Drawer";
import { DRAG_START_PX, dragOffset, swipeCloses } from "@/commons/lib/sheet-swipe";
import { cn } from "@/commons/lib/utils";

/** Its corners, its ground, and the room it leaves the home bar. */
const SHEET_BOX = "max-h-[85dvh] rounded-t-[22px] bg-base-200 pb-[env(safe-area-inset-bottom)] shadow-soft";
/** Open or put away, along the foot it comes from. */
const SHEET_PLACE = { open: "visible translate-y-0", closed: `${GONE} translate-y-full` } as const;
/** What a swipe down starts on: the sheet's head, or the head a sheet brings of its own. */
export const SHEET_GRAB = "data-sheet-grab";

export function Sheet({
  open,
  onClose,
  label,
  title,
  head = true,
  closeLabel,
  lazy = false,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** What it is, for whoever cannot see it rise. */
  label: string;
  /** Its name in its head: `label` unless given. */
  title?: ReactNode;
  /** Its own head: a grab line, its name and its close. `false` draws the grab line alone, over a head of its own. */
  head?: boolean;
  /** The close button's name: "Close" and the sheet's label unless given. */
  closeLabel?: string;
  /** Draw what is inside only once opened, and let it go after it closes. */
  lazy?: boolean;
  className?: string;
  children: ReactNode;
}) {
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

  useOpenFocus(open, panel, onClose, false);
  const swipe = useSwipeDown(panel, onClose);

  return createPortal(
    <>
      {/* The shade: a press on it closes the sheet. Out of the tab order, since the head's button is the close. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${label}`}
        data-sheet-shade=""
        onClick={onClose}
        className={cn("fixed inset-0 z-40", DRAWER_SHADE, open ? SHADE_PLACE.open : SHADE_PLACE.closed)}
      />
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        inert={!open}
        data-sheet=""
        data-open={open ? "" : undefined}
        onPointerDown={swipe}
        className={cn("fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden outline-none", SHEET_BOX, DRAWER_MOTION, open ? SHEET_PLACE.open : SHEET_PLACE.closed, className)}
      >
        {/* `touch-none`: the browser leaves a drag on the head to the sheet, not to a scroll of the page under it. */}
        <div {...{ [SHEET_GRAB]: "" }} className="shrink-0 touch-none select-none">
          <span aria-hidden="true" className="mx-auto mt-2.5 mb-1 block h-1.5 w-10 rounded-full bg-base-content/20" />
          {head ? (
            <div className="flex items-center gap-2 pr-2 pl-4">
              {typeof (title ?? label) === "string" ? (
                <h2 className="min-w-0 flex-1 truncate font-display text-lg font-medium tracking-tight">{title ?? label}</h2>
              ) : (
                <div className="min-w-0 flex-1">{title}</div>
              )}
              <button type="button" className="btn btn-ghost btn-square size-11 rounded-[14px] text-base-content/70 hover:text-base-content" onClick={onClose} aria-label={closeLabel ?? `Close ${label}`}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
        {drawn ? children : null}
      </div>
    </>,
    document.body,
  );
}

/**
 * A drag down that starts on a grab (`SHEET_GRAB`): the sheet follows the finger, and on letting go it is put away or
 * springs back (`swipeCloses`). Until the finger has moved a few pixels it is a press like any other, so a button in
 * the head still takes its tap; once it is a drag, the click that ends it is swallowed.
 */
function useSwipeDown(panel: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  return (start: ReactPointerEvent<HTMLDivElement>) => {
    const box = panel.current;
    const target = start.target as Element;
    if (!box || !start.isPrimary || start.button !== 0 || !target.closest(`[${SHEET_GRAB}]`)) return;
    const y0 = start.clientY;
    // The clock, not the events' own stamps: React's stand in for one that is 0, and the two were from different clocks.
    const t0 = performance.now();
    let dragging = false;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return;
      const dy = event.clientY - y0;
      if (!dragging && Math.abs(dy) < DRAG_START_PX) return;
      if (!dragging) {
        dragging = true;
        box.setPointerCapture?.(start.pointerId);
        box.style.transition = "none";
      }
      box.style.translate = `0 ${dragOffset(dy)}px`;
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragging) return;
      // Its own transition back: from where the finger left it, down and away or back up to rest.
      box.style.transition = "";
      box.style.translate = "";
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (event.type === "pointerup" && swipeCloses({ dy: event.clientY - y0, ms: performance.now() - t0 })) close.current();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
}
