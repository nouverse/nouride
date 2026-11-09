/**
 * What a save says it did: "Applied", or "Saved (takes effect after a restart)".
 *
 * Every form that changes a setting reports through this, so the words are the same on every page and the decision is
 * the daemon's: `restartRequired` in its answer, from the setter that wrote the key (`config/settings/*.ts` in the
 * engine). An answer that does not carry it changed nothing the daemon reads at boot — applied. A save that waits for
 * a restart is also kept until one (`markRestartPending`), so the strip above every page offers the Restart button
 * beside it, wherever the person goes next.
 */

import { useCallback } from "react";
import { useToast } from "@/commons/components/ui/toast";
import { markRestartPending } from "@/commons/lib/restart";

/** The two outcomes, word for word: the CLI says the same (`cli/saved.ts` in the engine). */
export const APPLIED = "Applied";
export const RESTART_NEEDED = "Saved (takes effect after a restart)";

/** Whether the daemon's answer to a save says it waits for a restart. */
export function needsRestart(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && (answer as { restartRequired?: unknown }).restartRequired === true;
}

/**
 * `(answer, what, detail?)` — `what` names the change as the person knows it ("Spend cap set to 5.00 USD a day"), and
 * `detail` adds what is worth knowing about it ("Nothing will refuse a turn on cost").
 */
export function useSaved(): (answer: unknown, what: string, detail?: string) => void {
  const toast = useToast();
  return useCallback(
    (answer: unknown, what: string, detail?: string) => {
      const said = detail ? `${what}. ${detail}` : what;
      if (!needsRestart(answer)) return void toast.success(APPLIED, said);
      markRestartPending(what);
      toast.warning(RESTART_NEEDED, said);
    },
    [toast],
  );
}
