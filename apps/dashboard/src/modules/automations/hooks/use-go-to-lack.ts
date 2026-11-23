/**
 * Going to what a save lacks first, from the bar that says it: the name's own field, or the box that holds it, opened
 * and brought into view. The bar stays at the window's foot, and with six steps drawn "Give it a name." was said of a
 * field a screen and a half up the page.
 */

import type { RefObject } from "react";
import type { DraftProblem } from "../lib/draft";
import { pathsOf } from "../lib/paths";
import type { Step, StepProblem } from "../lib/steps";
import { OPEN_RESULTS, OPEN_START, type Editor } from "./use-editor";

export function useGoToLack(page: RefObject<HTMLElement | null>, lack: DraftProblem | undefined, issue: StepProblem | undefined, steps: readonly Step[], editor: Pick<Editor, "setOpen">): () => void {
  return () => {
    if (!lack) return;
    const seen = (found: string) => page.current?.querySelector<HTMLElement>(found) ?? null;
    if (lack.part === "name") {
      seen('input[aria-label="Name"]')?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      seen('input[aria-label="Name"]')?.focus({ preventScroll: true });
      return;
    }
    // A question a step asks in its own box is that step's to open.
    const at = issue?.index ?? null;
    const within = at === null ? undefined : pathsOf(steps).inside.get(at);
    const step = at === null ? undefined : steps[within?.folded ? within.owner : at];
    const [opens, box] = lack.part === "start" ? [OPEN_START, '[aria-label="Start"]'] : lack.part === "who" ? [OPEN_RESULTS, '[aria-label="Who and where"]'] : [step?.id, `[data-flow-anchor="step:${step?.id}"]`];
    if (!opens) return;
    editor.setOpen(opens);
    seen(box)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };
}
