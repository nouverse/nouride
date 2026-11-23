/**
 * What an automation's canvas draws, one thing at a time: its steps, to be changed; a run, with how each step went and
 * the path it took; or a change an agent suggested, beside the steps as they run now.
 *
 * A change comes one of two ways. One an agent proposed to the automation as it runs waits on the server, as an
 * automation of its own, and is read against what is saved. One it wrote to what the person has open here, from the
 * chat over this page, waits on the page (`offered`), and is read against the draft as it stands: it is drawn the
 * moment it arrives, and it comes first while it waits, being what the person just asked for.
 */

import { useEffect, useState } from "react";
import type { AutomationSummary, JobRunSummary } from "@nouride/wire";
import type { Side } from "../components/SuggestedBanner";
import { draftOf, stepsOf, type Draft } from "../lib/draft";
import { live } from "../lib/runs";
import { stepMarks } from "../lib/suggested";

export interface AutomationDetail {
  automation: AutomationSummary;
  runs: JobRunSummary[];
  suggested?: AutomationSummary;
  timezone: string;
}

/**
 * `loaded`: the automation as the server holds it; `draft`: as the page is changing it; `home`: the server's time zone;
 * `offered`: the draft as a change from the chat would leave it, with the change's id, while one waits.
 */
export function useDrawn(detail: AutomationDetail | null, loaded: Draft, draft: Draft, home: string, offered: { id: string; draft: Draft } | null = null) {
  const automation = detail?.automation ?? null;
  const runs = detail?.runs ?? [];
  // One that is running, or waits for somebody, opens on that run.
  const [view, setView] = useState<"steps" | "run">(() => (live(runs[0]) ? "run" : "steps"));
  const [runId, setRunId] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("current");
  const suggested = detail?.suggested ?? null;
  // A change from the chat is shown as it arrives, on the steps: it is what the person is waiting to see. Once it is
  // answered the canvas is the draft's again.
  const offeredId = offered?.id ?? null;
  useEffect(() => {
    setSide(offeredId ? "suggested" : "current");
    if (offeredId) setView("steps");
  }, [offeredId]);
  const run = view === "run" ? (runs.find((one) => one.id === runId) ?? runs[0]) : undefined;
  const other = offered ? offered.draft : suggested ? draftOf(suggested, home) : null;
  const showsSuggested = other !== null && side === "suggested" && view === "steps";
  // A run is drawn over the steps as they are saved, not over a draft of them.
  const shown = showsSuggested ? other : run && automation ? loaded : draft;
  const marks =
    view !== "steps" ? null : offered ? stepMarks(draft.steps, offered.draft.steps) : suggested && automation ? stepMarks(stepsOf(automation.payload), stepsOf(suggested.payload)) : null;
  return {
    runs,
    view,
    setView,
    runId,
    side,
    setSide,
    suggested,
    run,
    showsSuggested,
    shown,
    /** What the suggested change would do to each step, for the side being looked at. */
    marks: showsSuggested ? marks?.suggested : marks?.current,
    /** A run picked from the list, or the newest: drawn over the steps. */
    showRun: (id: string | null) => {
      setRunId(id);
      setView("run");
    },
  };
}
