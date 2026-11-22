/**
 * What an automation's canvas draws, one thing at a time: its steps, to be changed; a run, with how each step went and
 * the path it took; or a change an agent suggested, beside the steps as they run now.
 */

import { useState } from "react";
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

/** `loaded`: the automation as the server holds it; `draft`: as the page is changing it; `home`: the server's time zone. */
export function useDrawn(detail: AutomationDetail | null, loaded: Draft, draft: Draft, home: string) {
  const automation = detail?.automation ?? null;
  const runs = detail?.runs ?? [];
  // One that is running, or waits for somebody, opens on that run.
  const [view, setView] = useState<"steps" | "run">(() => (live(runs[0]) ? "run" : "steps"));
  const [runId, setRunId] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("current");
  const suggested = detail?.suggested ?? null;
  const run = view === "run" ? (runs.find((one) => one.id === runId) ?? runs[0]) : undefined;
  const showsSuggested = suggested !== null && side === "suggested" && view === "steps";
  // A run is drawn over the steps as they are saved, not over a draft of them.
  const shown = showsSuggested ? draftOf(suggested, home) : run && automation ? loaded : draft;
  const marks = suggested && automation && view === "steps" ? stepMarks(stepsOf(automation.payload), stepsOf(suggested.payload)) : null;
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
