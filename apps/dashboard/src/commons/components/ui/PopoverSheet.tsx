/**
 * A panel opened from a button: under it, from a tablet's width up, and on a phone a sheet that rises from the foot of
 * the screen over a shade, a finger's reach from the thumb (`Drawer`, the motion of every drawer and of the app's More).
 * The list of agents to start a chat with opens in it.
 *
 * Under its button it is drawn at the body (`overPage`) through `Leaving`, so it is seen to go, and closed by Escape, by
 * a press outside it, or by its page; it takes the focus as it opens and gives it back to its button as it closes.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Drawer } from "@/commons/components/ui/Drawer";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { useWide } from "@/commons/hooks/use-wide";
import { placeMenu } from "@/commons/lib/menu-place";

interface PanelProps {
  onClose: () => void;
  /** The button it opens from: placed under it, and given the focus back. */
  anchor: RefObject<HTMLElement | null>;
  label: string;
  /** How wide it is under its button; a sheet is the phone's width. */
  width?: number;
  children: ReactNode;
}

export function PopoverSheet({ open, ...panel }: PanelProps & { open: boolean }) {
  const wide = useWide();
  if (!wide) {
    return (
      <Drawer open={open} onClose={panel.onClose} side="bottom" label={panel.label} lazy>
        <span aria-hidden="true" className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-base-content/20" />
        {panel.children}
      </Drawer>
    );
  }
  return <Leaving value={open}>{() => <UnderButton {...panel} />}</Leaving>;
}

function UnderButton({ onClose, anchor, label, width = 400, children }: PanelProps) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const at = anchor.current?.getBoundingClientRect();
      if (at) setPlace({ position: "fixed", ...placeMenu(at, { width: window.innerWidth, height: window.innerHeight }, { width, maxHeight: 560 }, "end") });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, width]);

  useEffect(() => {
    const button = anchor.current;
    // The panel's own first field or button, so typing a search needs no reach for the mouse.
    box.current?.querySelector<HTMLElement>("input, button, a[href]")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !button?.contains(target)) onClose();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", away);
      button?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; `onClose` is read when it fires
  }, []);

  return overPage(
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      style={place ?? { position: "fixed", visibility: "hidden" }}
      className="z-[1000] flex flex-col overflow-hidden rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft animate-enter"
    >
      {children}
    </div>,
  );
}
