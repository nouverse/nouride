/**
 * A panel opened from a button: under it, from a tablet's width up, and on a phone a sheet that rises from the foot of
 * the screen over a shade, a finger's reach from the thumb (`Sheet`, with its name and its close in its head). "Add a
 * step", the list of agents to start a chat with and a conversation's model open in it. What it holds names itself
 * under its button and leaves that to the sheet's head on a phone (`max-md:hidden`).
 *
 * Under its button it is drawn at the body (`overPage`) through `Leaving`, so it is seen to go, and closed by Escape, by
 * a press outside it, or by its page; it takes the focus as it opens and gives it back to its button as it closes.
 *
 * It opens where it is seen whole, over its button when there is no room for it below (`placeMenu`, by its own
 * height), follows its button as the page scrolls and closes when the button has left the window. Where it fits on
 * neither side it scrolls in itself: "Add a step" under a button low in the window was cut off at the window's edge,
 * with its last kinds out of reach.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Sheet } from "@/commons/components/ui/Sheet";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { useWide } from "@/commons/hooks/use-wide";
import { outOfSight, placeMenu } from "@/commons/lib/menu-place";

interface PanelProps {
  onClose: () => void;
  /** The button it opens from: placed under it, and given the focus back. */
  anchor: RefObject<HTMLElement | null>;
  label: string;
  /** Its name in a sheet's head, when shorter than `label`. */
  title?: string;
  /** How wide it is under its button; a sheet is the phone's width. */
  width?: number;
  /** Which edge of its button it lines up with, or its middle. */
  align?: "start" | "end" | "center";
  children: ReactNode;
}

export function PopoverSheet({ open, ...panel }: PanelProps & { open: boolean }) {
  const wide = useWide();
  if (!wide) {
    return (
      <Sheet open={open} onClose={panel.onClose} label={panel.label} title={panel.title ?? panel.label} lazy>
        {panel.children}
      </Sheet>
    );
  }
  return <Leaving value={open}>{() => <UnderButton {...panel} />}</Leaving>;
}

function UnderButton({ onClose, anchor, label, width = 400, align = "end", children }: Omit<PanelProps, "title">) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const closing = useRef(onClose);
  closing.current = onClose;

  useLayoutEffect(() => {
    // How tall it is with nothing holding it: read once, before it is placed and cut to the room it is given.
    const height = box.current?.offsetHeight || undefined;
    const measure = (event?: Event) => {
      // Its own list scrolling is no move of the page.
      if (event?.target instanceof Node && box.current?.contains(event.target)) return;
      const at = anchor.current?.getBoundingClientRect();
      if (!at || !anchor.current) return;
      if (event?.type === "scroll" && outOfSight(anchor.current, { height: window.innerHeight })) return closing.current();
      setPlace({ position: "fixed", ...placeMenu(at, { width: window.innerWidth, height: window.innerHeight }, { width, maxHeight: 560, ...(height ? { height } : {}) }, align) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, width, align]);

  useEffect(() => {
    const button = anchor.current;
    // The panel's own first field or button, so typing a search needs no reach for the mouse.
    box.current?.querySelector<HTMLElement>("input, button, a[href]")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      // A list one of the panel's own fields opened is drawn at the body (`Combobox`): a press on it picks from the
      // panel, and closing on it took the panel away before the pick landed.
      if (target instanceof Element && target.closest('[role="listbox"]')) return;
      if (!box.current?.contains(target) && !button?.contains(target)) onClose();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", away);
      // Without bringing it into view: closed because its button scrolled away, the page would jump back to the button.
      button?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; `onClose` is read when it fires
  }, []);

  return overPage(
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      // Before it is placed it is as wide as it will be, so its height is read as the height it will have.
      style={place ?? { position: "fixed", visibility: "hidden", width }}
      className="z-[1000] flex flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft [scrollbar-width:thin] animate-enter"
    >
      {children}
    </div>,
  );
}
