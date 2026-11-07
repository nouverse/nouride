/**
 * Where a dropdown goes on screen: under its button, or over it when there is no room below, and always inside the
 * window, 8 px from each edge. A list with a fixed width tied to one edge of its button went off a phone's screen, and
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
  return anchor.bottom <= 0 || anchor.top >= view.height;
}

const GAP = 6;
const MARGIN = 8;
/** Below this much room under the button, a list opens upwards if there is more room there. */
const ROOM = 240;

export function placeMenu(
  anchor: Box,
  view: { width: number; height: number },
  want: { width: number; maxHeight: number },
  align: "start" | "end",
): Place {
  const width = Math.max(0, Math.min(want.width, view.width - 2 * MARGIN));
  const wanted = align === "end" ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(wanted, MARGIN), view.width - MARGIN - width);
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = below < Math.min(want.maxHeight, ROOM) && above > below;
  const maxHeight = Math.max(0, Math.min(want.maxHeight, up ? above : below));
  return up ? { left, width, bottom: view.height - anchor.top + GAP, maxHeight } : { left, width, top: anchor.bottom + GAP, maxHeight };
}
