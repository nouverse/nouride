/**
 * A dialog drawn over the whole page, rendered at the body (0.8.11). A card's glass — `backdrop-blur`, a backdrop filter
 * — makes the card the containing block of anything `fixed` inside it: `report.md`'s dialog, opened from a mission's
 * Result card, was drawn inside that card and cut off by it. Every dialog goes through here
 * (`tests/dialogs-over-page.test.ts`).
 *
 * And every one opens and closes with motion (`main.css`, "Dialogs"): its box grows in as it is drawn, and goes back as it
 * closes. A dialog closes by its page no longer drawing it, which would take it off the screen at once, so the page
 * draws it through `Leaving`: that keeps it a moment longer, and the frame here says it is leaving.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LEAVE_MS } from "@/commons/lib/motion";

const LeavingContext = createContext(false);

export function overPage(dialog: ReactNode) {
  return createPortal(<Frame>{dialog}</Frame>, document.body);
}

/** No box of its own (`contents`): it only marks a dialog on its way out, which takes no click and no focus. */
function Frame({ children }: { children: ReactNode }) {
  const leaving = useContext(LeavingContext);
  return (
    <div className="contents" data-leaving={leaving ? "" : undefined} inert={leaving}>
      {children}
    </div>
  );
}

/**
 * The dialog for `value` while there is one, and for a moment after it is gone (`LEAVE_MS`), so it is seen to close:
 * `<Leaving value={reading}>{(at) => <DocumentDialog at={at} … />}</Leaving>`. A page draws a dialog this way, never on a
 * bare condition (`tests/dialog-motion.test.ts`).
 */
export function Leaving<T>({ value, children }: { value: T | null | undefined | false; children: (value: T) => ReactNode }) {
  const [last, setLast] = useState<T | null>(value || null);
  const leaving = !value && last !== null;

  useEffect(() => {
    if (value) setLast(value);
  }, [value]);

  useEffect(() => {
    if (!leaving) return;
    const gone = setTimeout(() => setLast(null), LEAVE_MS);
    return () => clearTimeout(gone);
  }, [leaving]);

  const shown = value || last;
  return shown ? <LeavingContext.Provider value={leaving}>{children(shown)}</LeavingContext.Provider> : null;
}
