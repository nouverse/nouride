/**
 * A list a person puts in another order: by dragging an item's handle, with the arrow keys on that handle, or with
 * buttons the item draws ("Move up", "Move down"). All three end in one `onMove(from, to)`; the list holds no order of
 * its own.
 *
 * Pointer events and CSS, no library. While an item is held it follows the pointer and the others stand aside by its
 * height (`lib/reorder.ts`); when the order changes, by any of the three, each item slides from where it was to where
 * it is, in its transform only, which the reduced-motion rule cuts to nothing. The items are laid out with no gap of
 * the list's own: what separates two of them is drawn inside one, so it moves with it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { dropIndex, shiftOf, type Slot } from "@/commons/lib/reorder";
import { cn } from "@/commons/lib/utils";

const SLIDE = "translate 200ms ease-out";

/** What an item is handed to draw its handle and its buttons with. */
export interface Grip {
  /** For the handle, a button: it drags with the pointer and moves the item with the arrow keys. */
  handle: ButtonHTMLAttributes<HTMLButtonElement>;
  /** One place up or down, for a button of the item's own. */
  move: (by: -1 | 1) => void;
  /** Held by the pointer right now. */
  held: boolean;
  first: boolean;
  last: boolean;
}

interface Drag {
  from: number;
  startY: number;
  dy: number;
  over: number;
  slots: Slot[];
}

export function ReorderList<T>({
  items,
  keyOf,
  onMove,
  nameOf,
  label,
  disabled = false,
  onHeld,
  className,
  children,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  onMove: (from: number, to: number) => void;
  /** What an item is called where its handle is named and a move is announced: "Step 2". */
  nameOf: (item: T, index: number) => string;
  /** The list's own name. */
  label: string;
  /** Nothing moves: the handles take no pointer and no key. */
  disabled?: boolean;
  /** Told when an item is picked up and when it is put down: for what is drawn over the list and cannot follow it. */
  onHeld?: (held: boolean) => void;
  className?: string;
  children: (item: T, index: number, grip: Grip) => ReactNode;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");
  /** Where each item was drawn before the order changed, by its key: what it slides from. */
  const before = useRef<Map<string, number> | null>(null);
  const order = items.map(keyOf).join("\n");

  const rows = () => [...(list.current?.children ?? [])].filter((row): row is HTMLElement => row instanceof HTMLElement && row.dataset.reorderKey !== undefined);

  /** The order is about to change: keep where each item is drawn now, the held one where the pointer left it. */
  const remember = useCallback(() => {
    before.current = new Map(rows().map((row) => [row.dataset.reorderKey!, row.getBoundingClientRect().top] as const));
  }, []);

  const move = useCallback(
    (from: number, to: number) => {
      if (disabled || to < 0 || to >= items.length || to === from) return;
      remember();
      setSaid(`${nameOf(items[from]!, from)} moved to place ${to + 1} of ${items.length}`);
      onMove(from, to);
    },
    [disabled, items, nameOf, onMove, remember],
  );

  // First, last, invert, play: each item is put back where it was drawn, then let go to slide to where it is.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was) return;
    const slid: HTMLElement[] = [];
    for (const row of rows()) {
      const from = was.get(row.dataset.reorderKey!);
      const by = from === undefined ? 0 : from - row.getBoundingClientRect().top;
      if (by === 0) continue;
      row.style.transition = "none";
      row.style.translate = `0 ${by}px`;
      slid.push(row);
    }
    if (slid.length === 0) return;
    // Read once, so the browser takes the place it slides from before it is told where to.
    void list.current?.offsetHeight;
    for (const row of slid) {
      row.style.transition = SLIDE;
      row.style.translate = "";
    }
    const done = setTimeout(() => {
      for (const row of slid) row.style.transition = "";
    }, 250);
    return () => clearTimeout(done);
  }, [order]);

  // While an item is held, the pointer is followed wherever it goes, and letting go anywhere puts the item down.
  const holding = drag !== null;
  const latest = useRef({ drag, move, onHeld });
  latest.current = { drag, move, onHeld };
  useEffect(() => {
    if (!holding) return;
    latest.current.onHeld?.(true);
    const follow = (event: PointerEvent) => {
      setDrag((held) => (held ? { ...held, dy: event.clientY - held.startY, over: dropIndex(held.slots, held.from, event.clientY - held.startY) } : held));
    };
    const drop = () => {
      const held = latest.current.drag;
      setDrag(null);
      if (held && held.over !== held.from) latest.current.move(held.from, held.over);
    };
    const cancel = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDrag(null);
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
    window.addEventListener("keydown", cancel);
    return () => {
      latest.current.onHeld?.(false);
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      window.removeEventListener("keydown", cancel);
    };
  }, [holding]);

  const grip = (item: T, index: number): Grip => ({
    held: drag?.from === index,
    first: index === 0,
    last: index === items.length - 1,
    move: (by) => move(index, index + by),
    handle: {
      type: "button",
      disabled,
      "aria-label": `Move ${nameOf(item, index)}: drag it, or press the up or down arrow`,
      // A finger on the handle drags the item, where on the card it scrolls the page.
      className: "touch-none cursor-grab active:cursor-grabbing",
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (disabled || event.button > 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        const slots = rows().map((row) => {
          const box = row.getBoundingClientRect();
          return { top: box.top, height: box.height };
        });
        setDrag({ from: index, startY: event.clientY, dy: 0, over: index, slots });
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        move(index, index + (event.key === "ArrowUp" ? -1 : 1));
      },
    },
  });

  return (
    <>
      <ol ref={list} aria-label={label} className={cn("list-none", drag && "select-none", className)}>
        {items.map((item, index) => {
          const held = drag?.from === index;
          const aside = drag && !held ? shiftOf(index, drag.from, drag.over, drag.slots[drag.from]?.height ?? 0) : 0;
          return (
            <li
              key={keyOf(item)}
              data-reorder-key={keyOf(item)}
              data-held={held ? "" : undefined}
              className={cn("relative", held && "z-10")}
              style={drag ? { transform: `translateY(${held ? drag.dy : aside}px)`, transition: held ? "none" : "transform 200ms ease-out" } : undefined}
            >
              {children(item, index, grip(item, index))}
            </li>
          );
        })}
      </ol>
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </>
  );
}
