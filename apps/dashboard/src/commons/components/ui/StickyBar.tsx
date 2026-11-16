/**
 * A page's own controls for what it lists (its tabs, its filter, its search), kept at the top of the window while the
 * page scrolls under them.
 *
 * Pages used to be held to the window with their list scrolling inside: the title, the description and the tabs stayed,
 * and what was left for the list was a strip between them and a band kept clear for the chat button, with cards cut
 * off at edges nobody could see. A page scrolls as a page now, and this one row stays in reach: what changes the list
 * is what a person reaches for halfway down it. One row, two where the window is narrow; the title scrolls away.
 *
 * A search that belongs to a part of the page under the row is drawn in the row too (`StickyTools`): the part keeps
 * what was typed and what was found, the row keeps the field in reach. Explore's search sat in its card and left with
 * it, so the one thing the tab is for was a scroll away from a long list.
 */

import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/commons/lib/utils";
import { HEAD_CHANGED } from "@/commons/hooks/use-head";

/**
 * Across the page's own gutter, so what scrolls under it is covered edge to edge. One pixel above the top of what
 * scrolls, which is how the row is seen to have stopped (`useAtRest`); its own top padding has that pixel back.
 */
const BAR = "sticky top-[calc(var(--head,0px)-1px)] transition-[top] duration-200 ease-out z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-[calc(0.5rem+1px)] pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8";

/**
 * Where a part of the page under the row draws its own search: at the row's end, or across what the tabs leave where
 * it asks to (`data-fill`), which is a line of its own where the window is narrow. Nothing there, it takes no room.
 */
const FROM_BELOW = "ml-auto flex min-w-0 flex-wrap items-center gap-2 empty:hidden has-[[data-fill]]:flex-[1_1_22rem]";

/** The row on the page now, for what is drawn into it from below: one page is shown at a time, so one row. */
let shown: HTMLElement | null = null;
const watching = new Set<() => void>();
function show(row: HTMLElement | null): void {
  shown = row;
  for (const tell of watching) tell();
}
const watch = (tell: () => void) => {
  watching.add(tell);
  return () => void watching.delete(tell);
};

/** Over the page: the page's own ground, and a short fade under the row, so a card goes under it rather than being cut by it. */
const OVER = "bg-app-bar after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-app-bar-fade after:content-['']";

/** What scrolls the row: the nearest box above it that scrolls down, or the window. */
function scrollerOf(row: HTMLElement): HTMLElement | null {
  for (let at = row.parentElement; at; at = at.parentElement) {
    const flow = getComputedStyle(at).overflowY;
    if (flow === "auto" || flow === "scroll") return at;
  }
  return null;
}

/**
 * Whether the row is where the page put it, with nothing passing under it. It is drawn with no ground then: a ground
 * of its own, however close to the page's, is a band across the page at rest. Stopped at the top, the row sits one
 * pixel above what scrolls it, which is the one case where it is not seen whole; the margins say that nothing below
 * or beside counts. Until that has been seen, and where it cannot be (no observer), the row keeps its ground:
 * a row with none over a list is the worse mistake.
 */
function useAtRest(row: RefObject<HTMLElement | null>): boolean {
  const [rest, setRest] = useState(false);
  // The phone's header over the top of what scrolls (`--head`, `useHead`): the row stops under it, so the top it is
  // measured against is the header's foot, and moves when the header goes up or comes back.
  const [head, setHead] = useState(0);
  useEffect(() => {
    const read = () => setHead(Number.parseFloat(document.documentElement.style.getPropertyValue("--head")) || 0);
    read();
    window.addEventListener(HEAD_CHANGED, read);
    return () => window.removeEventListener(HEAD_CHANGED, read);
  }, []);
  useEffect(() => {
    const at = row.current;
    if (!at || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => setRest((entries.at(-1)?.intersectionRatio ?? 0) >= 1), { root: scrollerOf(at), rootMargin: `${-head}px 9999px 99999px 9999px`, threshold: 1 });
    seen.observe(at);
    return () => seen.disconnect();
  }, [row, head]);
  return rest;
}

/**
 * `children`: the page's tabs, where it has any. `tools`: its filter and its search, at the row's end; under the tabs
 * where the window is too narrow for both.
 */
export function StickyBar({ children, tools, className, label }: { children?: ReactNode; tools?: ReactNode; className?: string; label?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const rest = useAtRest(row);
  // Its place for what is drawn from below, said while it is on the page and taken back when it leaves, if it is still
  // the one said: the next page's row is on the page before this one has gone.
  const mine = useRef<HTMLElement | null>(null);
  const below = useCallback((at: HTMLDivElement | null) => {
    if (at) show(at);
    else if (shown === mine.current) show(null);
    mine.current = at;
  }, []);
  return (
    <div ref={row} data-sticky-bar={rest ? "rest" : "over"} role="group" {...(label ? { "aria-label": label } : {})} className={cn(BAR, !rest && OVER, className)}>
      {children}
      {tools ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{tools}</div> : null}
      <div ref={below} data-sticky-tools className={FROM_BELOW} />
    </div>
  );
}

/**
 * A search or a filter of a part of the page under the row, drawn in the row. `fill`: across what the tabs leave, for
 * a search that is what its tab is for. Where the page has no such row (a part drawn by itself), it is drawn where it
 * is written, so nothing depends on the row to be usable.
 */
export function StickyTools({ children, fill }: { children: ReactNode; fill?: boolean }) {
  const row = useSyncExternalStore(watch, () => shown, () => null);
  const drawn = fill ? (
    <div data-fill className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {children}
    </div>
  ) : (
    children
  );
  return row ? createPortal(drawn, row) : <>{drawn}</>;
}
