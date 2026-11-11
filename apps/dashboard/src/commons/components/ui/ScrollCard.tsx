/**
 * A card whose list scrolls inside it: the header — title, description, and a filter box when one
 * is asked for — stays put, and the body stops at `maxHeight`. For lists that grow without bound
 * (skills, drafts, search results), so forty of them do not push the rest of the page out of reach.
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";
import { Card } from "./ui";
import { SearchInput } from "./SearchInput";

/**
 * The space under a page's last card. On a phone and a tablet the tab bar floats over the page's foot (`TabBar`), with
 * the browser's toolbar and the home indicator under it: 9rem past the safe area, the bar's 4.75rem and room to see the
 * last card clear of it. It was 7rem, and the last line of a page sat a finger's width above the bar, read as under it.
 * From a laptop up, a page that scrolls ends 5rem above the window's foot, where it ended 2rem above it and the last
 * card looked cut by the window's edge.
 */
export const PAGE_BOTTOM = "pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-20";

/**
 * The same under a page held to the window from a laptop up (`fillsViewport`, System Logs, Secrets): nothing scrolls
 * under its last card there, the card's own list does, so it keeps the 2rem the page has on its other sides.
 */
export const HELD_BOTTOM = "pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8";

/**
 * A page laid out to fill the window (`staticData: { fillsViewport: true }`): its root, a column the list takes the rest
 * of — from a laptop's width up. On a phone the page scrolls as a document and the list grows with it (`lg:` on each).
 */
// Its children keep their height (`shrink-0`): a tab bar scrolls sideways, so as a flex item it could shrink to a
// sliver — it did, on MCP. Only the list grows into what is left (`fill`), and never below its own minimum. Each fades
// in as it is drawn (`*:animate-fade`), so a tab's panel, or a form opened above the list, shows where it came from: one
// that stays is not drawn again, and does not move. A list a tab only filters is keyed by the tab, to be drawn anew.
//
// And a foot of its own, after its last child: the layout's padding is inside the height the page is held to, so a page
// that runs past the window anyway — a short window, a form open above the list, a tab that runs down the page — ended
// flush with the window's foot. The foot's margins take back its height and the gap before it, so it takes nothing
// from a list that fills the window: it lies in the layout's padding there, and under the last child where the page
// scrolls.
const HELD_FOOT = "lg:after:block lg:after:h-8 lg:after:shrink-0 lg:after:-mt-6 lg:after:-mb-8 lg:after:content-['']";
export const FILL_PAGE = `flex min-h-0 flex-1 flex-col gap-6 [&>*]:shrink-0 *:animate-fade ${HELD_FOOT}`;

/**
 * Under a part of a held page that runs down the page as a document does (Skills' Explore): with the held page's own
 * foot, the room a page that scrolls ends with (`PAGE_BOTTOM`).
 */
export const RUNS_DOWN = "lg:pb-12";

/** The bounded, scrolling region on its own — for a list that is not one card, like Schedule's jobs. */
export function ScrollArea({
  maxHeight = "max-h-[70dvh]",
  fill = false,
  className,
  children,
}: {
  /** A Tailwind max-height class. Written out in full so the build sees it. */
  maxHeight?: string;
  /** Take the height a `FILL_PAGE` leaves, rather than `maxHeight`. */
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn(fill ? "lg:min-h-[16rem] lg:flex-1 lg:overflow-y-auto lg:overscroll-contain" : `${maxHeight} overflow-y-auto overscroll-contain`, className)}>{children}</div>;
}

export function ScrollCard({
  title,
  description,
  actions,
  search,
  maxHeight = "max-h-[32rem]",
  fill = false,
  className,
  children,
}: {
  /** Take the height a `FILL_PAGE` leaves, rather than `maxHeight` — the list scrolls, the page around it does not. */
  fill?: boolean;
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** A filter box in the header, beside any actions. */
  search?: { value: string; onChange: (next: string) => void; placeholder?: string };
  /** A Tailwind max-height class. Written out in full so the build sees it. */
  maxHeight?: string;
  /** On the card itself — a border that says something is waiting, say. */
  className?: string;
  children: ReactNode;
}) {
  const header =
    search || actions ? (
      <div className="flex flex-wrap items-center gap-2">
        {search ? <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder} className="w-48" /> : null}
        {actions}
      </div>
    ) : undefined;
  return (
    <Card
      {...(title ? { title } : {})}
      {...(description ? { description } : {})}
      {...(header ? { actions: header } : {})}
      className={cn(fill && "lg:flex lg:min-h-[22rem] lg:flex-1 lg:flex-col", className)}
      bodyClassName={fill ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain" : `${maxHeight} overflow-y-auto overscroll-contain`}
    >
      {children}
    </Card>
  );
}
