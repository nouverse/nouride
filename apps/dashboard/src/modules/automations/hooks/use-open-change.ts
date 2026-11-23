/**
 * A change an agent wrote to the automation open on this page, from the chat over it (`commons/hooks/use-live-edit`):
 * what the page says it holds, the change as the draft it would leave, and what Apply, Discard and Undo do.
 *
 * Apply puts the change into the draft and saves nothing; the draft as it was is kept for the way back, until the
 * page's draft is anything else again (another change by hand, a save, a discard): past that, going back would also
 * take what was done since.
 */

import { useMemo, useState } from "react";
import type { AutomationChange } from "@nouride/wire";
import { useLiveEdit } from "@/commons/hooks/use-live-edit";
import { draftAfter, openValue, type Draft } from "../lib/draft";

export interface OpenChange {
  /** The change waiting, as the draft it would leave, with its id and the agent that wrote it; none where none waits. */
  offered: { id: string; by: string; draft: Draft } | null;
  /** The agent whose change was just applied, while the draft is still as that change left it. */
  applied: string | null;
  apply: () => void;
  discard: () => void;
  undo: () => void;
  /** The applied change's bar put away: the change stays in the draft. */
  settle: () => void;
}

/**
 * `id`: the automation's, or none for one being made. `enabled`: only where this page can change it. `restore` puts a
 * whole draft on the page (`Editor.restore`).
 */
export function useOpenChange(page: { id: string | null; draft: Draft; home: string; enabled: boolean; restore: (draft: Draft) => void }): OpenChange {
  const { draft, home, restore } = page;
  const live = useLiveEdit<AutomationChange>({ kind: "automation", id: page.id, value: () => openValue(draft), enabled: page.enabled });
  const change = live.offer;
  const offered = useMemo(() => (change ? { id: change.id, by: change.by, draft: draftAfter(draft, change.value, home) } : null), [change, draft, home]);
  const [applied, setApplied] = useState<{ before: Draft; after: Draft; by: string } | null>(null);
  return {
    offered,
    applied: applied && draft === applied.after ? applied.by : null,
    apply: () => {
      if (!offered) return;
      setApplied({ before: draft, after: offered.draft, by: offered.by });
      restore(offered.draft);
      live.done();
    },
    discard: live.done,
    undo: () => {
      if (applied) restore(applied.before);
      setApplied(null);
    },
    settle: () => setApplied(null),
  };
}
