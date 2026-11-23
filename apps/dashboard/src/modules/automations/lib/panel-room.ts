/**
 * How tall the panel beside an automation's canvas may be: from where it stands to the window's foot, less a margin.
 * Pure (`tests/automation-panel-room.test.ts`); `hooks/use-panel-room.ts` reads the page and writes the answer.
 *
 * The panel was as tall as "the window less 13rem", a guess at the page's head over it. With the page scrolled the
 * head was gone and the guess left a hand's width of nothing under the panel, while the panel's own fields were cut
 * off above it. So the room is measured: the panel stands at its row's top until that scrolls past, then stays a
 * margin under the window's top, and ends a margin over the window's foot. Where the chat's button floats over the
 * panel's corner, it ends over the button: Done is at that corner.
 */

export interface Span {
  left: number;
  right: number;
  top: number;
}

/** The margin kept at the window's top once the page is scrolled (the panel's `top-4`), and at its foot. */
export const PANEL_MARGIN = 16;
/** Never shorter than a few fields: in a window too short for that, the page scrolls to the rest. */
const LEAST = 280;
const CLEAR = 12;

export function panelRoom(at: { /** The top of the row the panel stands in, in the window. */ rowTop: number; viewHeight: number; panel: Pick<Span, "left" | "right">; /** The chat's button, where it is drawn. */ chat: Span | null }): number {
  const top = Math.max(at.rowTop, PANEL_MARGIN);
  const over = at.chat && at.chat.left < at.panel.right && at.chat.right > at.panel.left ? at.chat.top - CLEAR : at.viewHeight - PANEL_MARGIN;
  return Math.max(LEAST, Math.round(over - top));
}
