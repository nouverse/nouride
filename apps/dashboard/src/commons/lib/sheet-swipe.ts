/**
 * Whether a drag down on a sheet's head puts the sheet away (`Sheet`). Past a short distance it does; a quick flick
 * shorter than that does too, as a phone's own sheets do; anything less springs back, so a finger that only rested on
 * the head, or slid a little while pressing a button there, closes nothing.
 */

/** How far down a drag must go to put a sheet away, in CSS pixels: about a thumb's width. */
export const SWIPE_CLOSE_PX = 72;
/** A flick: at least this far, at this speed or faster (px per ms), puts it away as well. */
const FLICK_MIN_PX = 24;
const FLICK_SPEED = 0.6;
/** How far a finger moves before a press on the head is a drag and not a tap on what it pressed. */
export const DRAG_START_PX = 6;

export function swipeCloses(drag: { dy: number; ms: number }): boolean {
  if (drag.dy >= SWIPE_CLOSE_PX) return true;
  return drag.dy >= FLICK_MIN_PX && drag.dy / Math.max(drag.ms, 1) >= FLICK_SPEED;
}

/** Where the sheet stands while it is dragged: with the finger downward, never above where it rests. */
export function dragOffset(dy: number): number {
  return Math.max(0, dy);
}
