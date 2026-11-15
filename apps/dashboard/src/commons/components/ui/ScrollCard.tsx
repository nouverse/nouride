/**
 * For the few pages that keep a list scrolling inside the window (Files, the Workspace, Logs): the room under a page,
 * the page held to the window, and the area in it that scrolls. Every other page scrolls as a page, with its tabs,
 * filter and search in a row that stays (`StickyBar`) and its long lists opened in full (`ListCard`).
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

/**
 * The space under a page's last card. On a phone and a tablet the tab bar floats over the page's foot (`TabBar`), with
 * the browser's toolbar and the home indicator under it, and the floating chat's button stands over the bar's right end
 * (`FloatingChat`): 11rem past the safe area, the button's top at 9rem and room to see the last card clear of it.
 * It was 7rem, and the last line of a page sat a finger's width above the bar, read as under it. From a laptop up, a
 * page that scrolls ends 5rem above the window's foot, over the button in its corner, where it ended 2rem above the
 * foot and the last card looked cut by the window's edge.
 */
export const PAGE_BOTTOM = "pb-[calc(11rem+env(safe-area-inset-bottom))] lg:pb-20";

/**
 * The same under a page held to the window from a laptop up (`fillsViewport`, System Logs): its card runs to the 2rem
 * the page has on its other sides, and the floating chat's button lies over the card's corner. It ended 5rem above the
 * window's foot, to leave the button a place of its own, and that was a blank band under the card for as long as the
 * page was open. What scrolls in the card ends with room to bring its last row clear of the button (`HELD_END`).
 */
export const HELD_BOTTOM = "pb-[calc(11rem+env(safe-area-inset-bottom))] lg:pb-8";

/**
 * The room at the end of what scrolls inside a held page's card, from a laptop up: the floating chat's button stands
 * 2.5rem into the card's foot, so a list ends 3.5rem past its last row, which then scrolls to stand clear of it.
 */
export const HELD_END = "lg:pb-14";

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
 * What scrolls inside a held page's card, from a laptop up: it takes the height the page leaves, never less than a few
 * rows, and ends with room for the floating chat's button (`HELD_END`). On a phone it is as tall as what it holds.
 */
export function ScrollArea({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(`lg:min-h-[16rem] lg:flex-1 lg:overflow-y-auto lg:overscroll-contain ${HELD_END}`, className)}>{children}</div>;
}
