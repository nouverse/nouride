/**
 * Cards side by side: one across on a phone, two on a tablet, three on a wide screen. The Knowledge tab's collections and
 * the Missions list use this one grid and `CARD` for each card's frame (0.8.20: the owner asked for missions laid out as
 * the collections are), so the two pages cannot drift apart.
 */

import type { ReactNode } from "react";

/** One card's frame: its border, surface, corners and padding. */
export const CARD = "border-base-content/[0.08] bg-base-100 relative flex flex-col gap-3 rounded-[22px] border p-5 shadow-soft transition-colors";

/**
 * A card that is itself what opens something — a mission, a background helper, an agent — lifted a little under the
 * pointer, so it reads as one thing to open: its transform only, over 200 ms, easing out. A card that opens nothing does
 * not lift. A press still sinks it (`active:scale-*`), and the reduced-motion rule keeps both still.
 */
export const LIFTS = "transition-[translate,scale,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5";

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}
