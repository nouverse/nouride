/**
 * An automation's last twenty runs, newest first: how each went, when, how long it took, and its result in a line. A
 * press on one draws that run over the steps. What a run's guards held with nobody there to ask is under it, each
 * allowed always for this automation with a press, as before.
 */

import type { JobRunSummary } from "@nouride/wire";
import { HeldActions } from "@/commons/components/jobs/Allowances";
import { cn } from "@/commons/lib/utils";
import { live, ranFor, runWords, took, whenWords, type Tone } from "../lib/runs";

/** A run's dot: mint for done and at work, red for a failure, pink for what waits on a person, grey for the rest. */
const DOT: Record<Tone, string> = { done: "bg-success", failed: "bg-error", quiet: "bg-base-content/30", working: "bg-success animate-pulse", needs: "bg-accent animate-pulse" };

export function RecentRuns({
  jobId,
  runs,
  picked,
  onPick,
  canAllow,
}: {
  jobId: string;
  runs: readonly JobRunSummary[];
  /** The run drawn over the steps, by its id; none while the steps are being edited. */
  picked: string | null;
  onPick: (run: JobRunSummary) => void;
  canAllow: boolean;
}) {
  return (
    <section aria-label="Recent runs" className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
      <h2 className="px-1 text-lg text-base-content">Recent runs</h2>
      {runs.length === 0 ? (
        <p className="px-1 pt-1.5 text-sm text-base-content/65">It has not run yet.</p>
      ) : (
        <ul className="mt-2 max-h-[26rem] list-none space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
          {runs.map((run) => {
            const { label, tone } = runWords(run);
            const on = picked === run.id;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  className={cn("flex w-full items-start gap-2.5 rounded-[14px] px-2.5 py-2 text-left transition-colors", on ? "bg-secondary/10" : "hover:bg-base-content/[0.04]")}
                  onClick={() => onPick(run)}
                >
                  <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[tone])} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className={cn("text-sm", on ? "font-bold text-base-content" : "font-semibold text-base-content/90")}>{whenWords(run.startedAt)}</span>
                      <span className="text-xs text-base-content/65">{live(run) ? label : `${label} · ${took(ranFor(run))}`}</span>
                    </span>
                    {/* Words only: a mission it names is a link on the step's card, where a link is not inside a button. */}
                    {run.result ? <span className={cn("block truncate text-xs", on ? "text-secondary" : "text-base-content/65")}>{run.result}</span> : null}
                  </span>
                </button>
                {run.held?.length ? (
                  <div className="px-2.5 pb-1.5 pl-7">
                    <HeldActions jobId={jobId} held={run.held} canEdit={canAllow} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
