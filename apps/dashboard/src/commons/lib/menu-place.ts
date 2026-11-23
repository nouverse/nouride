/**
 * Where a dropdown goes on screen: under its button, or over it when there is no room below, and always inside the
 * window, 8 px from each edge. One that says how tall it is (`height`) opens where it is seen whole: the list of a
 * step's kinds, 480 px of it, opened under a button with 300 px below it and was cut off there with room above. A list with a fixed width tied to one edge of its button went off a phone's screen, and
 * one drawn inside a card went under the next card (a blurred card is a stacking context): every dropdown is drawn
 * on `document.body` at this place instead (`DropdownMenu`, `Combobox`, the graph's `MultiSelect`). Pure, so the
 * cases are tested without a browser.
 */

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Place {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Whether a button has left the window: its menu closes rather than float with nothing under it. */
export function offScreen(anchor: Box, view: { height: number }): boolean {
  // Strictly past an edge: a box with no layout (0 by 0 at the corner) is not taken for one that scrolled away.
  return anchor.bottom < 0 || anchor.top > view.height;
}

/**
 * Whether a button scrolled out of what holds it: past the edge of a card or a list that scrolls. Its menu, drawn on
 * the body, would follow it there and lie over the card's own head. `around`: the boxes of what scrolls around it,
 * nearest first (`holders`, read off the page).
 */
export function scrolledOut(anchor: Box, around: readonly Pick<Box, "top" | "bottom">[]): boolean {
  return around.some((box) => anchor.bottom <= box.top || anchor.top >= box.bottom);
}

/**
 * The boxes of everything around an element that scrolls what it holds. Not what only clips: nothing scrolls out of
 * that, and a clipping box is not always around what is drawn inside it (a button placed by a box further out).
 */
function holders(element: Element): Pick<Box, "top" | "bottom">[] {
  const found: Pick<Box, "top" | "bottom">[] = [];
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) found.push(parent.getBoundingClientRect());
  }
  return found;
}

/** A button no longer in sight: out of the window, or out of the card it is in. Its menu closes. */
export const outOfSight = (element: Element, view: { height: number }): boolean => {
  const box = element.getBoundingClientRect();
  return offScreen(box, view) || scrolledOut(box, holders(element));
};

const GAP = 6;
const MARGIN = 8;
/** Below this much room under the button, a list opens upwards if there is more room there. */
const ROOM = 240;

export function placeMenu(
  anchor: Box,
  view: { width: number; height: number },
  /** `height`: how tall what it holds is, where that is known. Without it, a list is taken to need `ROOM`. */
  want: { width: number; maxHeight: number; height?: number },
  align: "start" | "end" | "center",
): Place {
  const width = Math.max(0, Math.min(want.width, view.width - 2 * MARGIN));
  const wanted = align === "end" ? anchor.right - width : align === "center" ? Math.round((anchor.left + anchor.right - width) / 2) : anchor.left;
  const left = Math.min(Math.max(wanted, MARGIN), view.width - MARGIN - width);
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = below < Math.min(want.maxHeight, want.height ?? ROOM) && above > below;
  const maxHeight = Math.max(0, Math.min(want.maxHeight, up ? above : below));
  return up ? { left, width, bottom: view.height - anchor.top + GAP, maxHeight } : { left, width, top: anchor.bottom + GAP, maxHeight };
}
