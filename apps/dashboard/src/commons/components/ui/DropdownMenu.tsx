/**
 * A button that opens a menu, the one way the dashboard does it: the menu is drawn on `document.body`, placed by
 * `placeMenu` (inside the window, flipped up when there is no room below), and closed by a click elsewhere, Escape, an
 * item that calls `close`, or its button scrolling out of the window. Replaces daisyUI's `dropdown`, whose fixed-width list tied to the button's edge left a
 * phone's screen and slid under the next card.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { offScreen, placeMenu } from "@/commons/lib/menu-place";

export function DropdownMenu({
  trigger,
  triggerClassName,
  ariaLabel,
  width,
  maxHeight = 360,
  align = "end",
  menuClassName,
  children,
}: {
  trigger: ReactNode;
  triggerClassName: string;
  ariaLabel?: string;
  /** The menu's width where the window has room for it; narrower on a phone, never wider than the window. */
  width: number;
  maxHeight?: number;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  menuClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = button.current?.getBoundingClientRect();
      if (!box) return;
      if (offScreen(box, { height: window.innerHeight })) {
        setOpen(false);
        return;
      }
      setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width, maxHeight }, align) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, width, maxHeight, align]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && place && createPortal(
        <ul ref={menu} role="menu" style={place} className={`menu z-[1000] flex-nowrap overflow-y-auto ${menuClassName}`}>
          {children(close)}
        </ul>,
        document.body,
      )}
    </>
  );
}
