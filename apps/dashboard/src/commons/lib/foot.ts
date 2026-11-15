/**
 * Whether a phone's tab bar is at the foot of the screen, as a page scrolls (`useFoot`). It goes away once the page
 * has been scrolled down past a short distance, and is back at the first scroll up, so reading down a long page has
 * the whole screen and the way to another page is one flick away. It is always there at the page's top, while More is
 * open, and on a page too short to scroll, where nothing would ever bring it back.
 *
 * The position is held inside the page's own range first: a phone's browser bounces past the top and the foot, and a
 * bounce back up from past the foot read as a scroll up and brought the bar back in a flicker.
 */

/** How far down from where a downward scroll began before the bar goes. */
export const HIDE_AFTER_PX = 48;
/** Within this of the top the bar is always there. */
const TOP_PX = 8;

export interface FootState {
  shown: boolean;
  /** Where the last scroll event left the page, held to its range. */
  lastY: number;
  /** Where the current run downward began. */
  downFrom: number;
}

export const FOOT_AT_REST: FootState = { shown: true, lastY: 0, downFrom: 0 };

export function nextFoot(state: FootState, scroll: { y: number; maxY: number; more: boolean }): FootState {
  // Held to the page's range: a page too short to scroll is always at its top.
  const y = Math.min(Math.max(scroll.y, 0), Math.max(0, scroll.maxY));
  if (scroll.more || y <= TOP_PX) return { shown: true, lastY: y, downFrom: y };
  if (y < state.lastY) return { shown: true, lastY: y, downFrom: y };
  if (y > state.lastY) return { shown: state.shown && y - state.downFrom < HIDE_AFTER_PX, lastY: y, downFrom: state.downFrom };
  return state;
}
