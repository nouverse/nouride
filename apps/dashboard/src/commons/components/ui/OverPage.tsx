/**
 * A dialog drawn over the whole page, rendered at the body (0.8.11). A card's glass — `backdrop-blur`, a backdrop filter
 * — makes the card the containing block of anything `fixed` inside it: `report.md`'s dialog, opened from a mission's
 * Result card, was drawn inside that card and cut off by it. Every dialog goes through here
 * (`tests/dialogs-over-page.test.ts`).
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function overPage(dialog: ReactNode) {
  return createPortal(dialog, document.body);
}
