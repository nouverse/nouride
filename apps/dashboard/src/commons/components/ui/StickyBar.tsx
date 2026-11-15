/**
 * A page's own controls for what it lists (its tabs, its filter, its search), kept at the top of the window while the
 * page scrolls under them.
 *
 * Pages used to be held to the window with their list scrolling inside: the title, the description and the tabs stayed,
 * and what was left for the list was a strip between them and a band kept clear for the chat button, with cards cut
 * off at edges nobody could see. A page scrolls as a page now, and this one row stays in reach: what changes the list
 * is what a person reaches for halfway down it. One row, two where the window is narrow; the title scrolls away.
 */

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { cn } from "@/commons/lib/utils";

/**
 * Across the page's own gutter, so what scrolls under it is covered edge to edge. One pixel above the top of what
 * scrolls, which is how the row is seen to have stopped (`useAtRest`); its own top padding has that pixel back.
 */
const BAR = "sticky -top-px z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-[calc(0.5rem+1px)] pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8";

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
  useEffect(() => {
    const at = row.current;
    if (!at || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => setRest((entries.at(-1)?.intersectionRatio ?? 0) >= 1), { root: scrollerOf(at), rootMargin: "0px 9999px 99999px 9999px", threshold: 1 });
    seen.observe(at);
    return () => seen.disconnect();
  }, [row]);
  return rest;
}

/**
 * `children`: the page's tabs, where it has any. `tools`: its filter and its search, at the row's end; under the tabs
 * where the window is too narrow for both.
 */
export function StickyBar({ children, tools, className, label }: { children?: ReactNode; tools?: ReactNode; className?: string; label?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const rest = useAtRest(row);
  return (
    <div ref={row} data-sticky-bar={rest ? "rest" : "over"} role="group" {...(label ? { "aria-label": label } : {})} className={cn(BAR, !rest && OVER, className)}>
      {children}
      {tools ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{tools}</div> : null}
    </div>
  );
}
