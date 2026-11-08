/**
 * The page you are on, marked in the sidebar by one highlight that moves to the item you open, where the mark jumped from
 * item to item. It sits under the current item (`aria-current="page"`), placed each time the sidebar is drawn — a page
 * opened, an item added above — and once the page's fonts have come, which moves the items. Only its place moves
 * (`translate`, 200 ms, easing out); its size is set, not moved, and its first placement does not move at all. It goes
 * first in a `relative isolate` nav, under the items (`-z-10`), and scrolls with them.
 */

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { cn } from "@/commons/lib/utils";

interface Place {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Over the nav's current item, or nowhere when the page is none of its items. */
function placeOf(nav: HTMLElement | null): Place | null {
  const current = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
  return current ? { top: current.offsetTop, left: current.offsetLeft, width: current.offsetWidth, height: current.offsetHeight } : null;
}

const same = (a: Place | null, b: Place | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

export function NavHighlight({ nav }: { nav: RefObject<HTMLElement | null> }) {
  const [place, setPlace] = useState<Place | null>(null);
  // Still until it has been placed once: drawn moving, it would fly in from the nav's top as the page opens.
  const [moves, setMoves] = useState(false);

  const measure = () =>
    setPlace((was) => {
      const next = placeOf(nav.current);
      return same(was, next) ? was : next;
    });

  // Every draw, before it is painted.
  useLayoutEffect(measure);

  // And once the nav is there — it is not yet as this is first drawn, its ref being set after what is inside it — and
  // once the fonts have come.
  useEffect(() => {
    measure();
    void document.fonts?.ready.then(measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once; `measure` reads the nav through its ref, never a stale one
  }, []);

  useEffect(() => {
    if (!place || moves) return;
    const frame = requestAnimationFrame(() => setMoves(true));
    return () => cancelAnimationFrame(frame);
  }, [place, moves]);

  return (
    <span
      aria-hidden="true"
      data-current-mark=""
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-10 rounded-[14px] bg-secondary/10",
        moves && "transition-[translate] duration-200 ease-out",
        !place && "invisible",
      )}
      style={place ? { translate: `${place.left}px ${place.top}px`, width: place.width, height: place.height } : undefined}
    />
  );
}
