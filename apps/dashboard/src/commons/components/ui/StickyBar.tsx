/**
 * A page's own controls for what it lists (its tabs, its filter, its search), kept at the top of the window while the
 * page scrolls under them.
 *
 * Pages used to be held to the window with their list scrolling inside: the title, the description and the tabs stayed,
 * and what was left for the list was a strip between them and a band kept clear for the chat button, with cards cut
 * off at edges nobody could see. A page scrolls as a page now, and this one row stays in reach: what changes the list
 * is what a person reaches for halfway down it. One row, two where the window is narrow; the title scrolls away.
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

/**
 * Across the page's own gutter, on the page's ground, so what scrolls under it is covered edge to edge; and a short
 * fade under it, so a card goes under the row rather than being cut by it.
 */
const BAR =
  "bg-app-bar sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 " +
  "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-(--app-ground) after:to-transparent after:content-['']";

/**
 * `children`: the page's tabs, where it has any. `tools`: its filter and its search, at the row's end; under the tabs
 * where the window is too narrow for both.
 */
export function StickyBar({ children, tools, className, label }: { children?: ReactNode; tools?: ReactNode; className?: string; label?: string }) {
  return (
    <div data-sticky-bar role="group" {...(label ? { "aria-label": label } : {})} className={cn(BAR, className)}>
      {children}
      {tools ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{tools}</div> : null}
    </div>
  );
}
