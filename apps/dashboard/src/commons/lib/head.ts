/**
 * Whether a phone's header is at the top of the screen, as a page scrolls (`useHead`). It goes up once the page has
 * been scrolled down past a short distance, and is back at the first scroll up, so reading down a long page has the
 * whole screen and the header is one flick away. It is always there at the page's top, and on a page too short to
 * scroll, where nothing would ever bring it back.
 *
 * The position is held inside the page's own range first: a phone's browser bounces past the top and the foot, and a
 * bounce back up from past the foot read as a scroll up and brought it back in a flicker.
 */

/** How far down from where a downward scroll began before the header goes. */
const HIDE_AFTER_PX = 48;
/** Within this of the top the header is always there. */
const TOP_PX = 8;

export interface HeadState {
  shown: boolean;
  /** Where the last scroll event left the page, held to its range. */
  lastY: number;
  /** Where the current run downward began. */
  downFrom: number;
}

export const HEAD_AT_REST: HeadState = { shown: true, lastY: 0, downFrom: 0 };

export function nextHead(state: HeadState, scroll: { y: number; maxY: number }): HeadState {
  const y = Math.min(Math.max(scroll.y, 0), Math.max(0, scroll.maxY));
  if (y <= TOP_PX) return { shown: true, lastY: y, downFrom: y };
  if (y < state.lastY) return { shown: true, lastY: y, downFrom: y };
  if (y > state.lastY) return { shown: state.shown && y - state.downFrom < HIDE_AFTER_PX, lastY: y, downFrom: state.downFrom };
  return state;
}
