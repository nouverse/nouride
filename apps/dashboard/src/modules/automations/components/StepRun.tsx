/**
 * How one step went in the run being looked at, drawn in the step's card: done and how long it took, failed and why,
 * nothing to say, at work, or waiting. What it said is folded under it, a command's output in the mono face, a failure's
 * reason open. A step that waits for a person carries the question and its two answers right here; one that waits for
 * a mission links to that mission's page.
 */

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { RunResult } from "@/commons/components/jobs/RunResult";
import { StepQuestion } from "@/commons/components/jobs/WaitingStep";
import { cn } from "@/commons/lib/utils";
import { outcomeWords, type Tone } from "../lib/runs";

/** A run's chip in each tone: mint for done and at work, red for a failure only, pink for what waits on a person. */
export const TONES: Record<Tone, string> = {
  done: "bg-success/15 text-success",
  failed: "bg-error/10 text-error",
  quiet: "bg-base-content/[0.06] text-base-content/70",
  working: "bg-success/15 text-success",
  needs: "bg-accent/15 text-accent",
};

function RunChip({ label, tone, live = false }: { label: string; tone: Tone; live?: boolean }) {
  return (
    <span data-tone={tone} className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold", TONES[tone])}>
      {/* At work: a dot that pulses, which the reduced-motion rule holds still. */}
      {live ? <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {label}
    </span>
  );
}

export function StepRun({
  outcome,
  run,
  name,
  before,
  canAnswer,
  whom,
}: {
  outcome: StepRunOutcome;
  run: JobRunSummary;
  /** The automation's name, for what an answer's toast says. */
  name: string;
  /** What the step before said, for a step that waits for a person to decide on. */
  before?: string | undefined;
  canAnswer: boolean;
  /** Who answers it while it waits for a person, where that is not the reader. */
  whom?: string | undefined;
}) {
  const { label, tone } = outcomeWords(outcome, whom);
  const asking = outcome.status === "waiting" && run.waiting?.kind === "approval" && run.waiting.step === outcome.id ? run.waiting : null;
  const failed = outcome.status === "failed";
  // A step that waits says its own question as what it said: that is drawn as the question, not repeated under it.
  const said = asking || outcome.status === "waiting" ? undefined : outcome.said;
  return (
    <div className="space-y-2.5">
      <RunChip label={label} tone={tone} live={outcome.status === "running" || outcome.status === "waiting"} />
      {/* The question is the card's own line, over this: it is asked once. */}
      {asking ? <StepQuestion runId={run.id} name={name} said={before} until={asking.until} canAnswer={canAnswer} whom={whom} /> : null}
      {outcome.missionId ? (
        <Link to="/missions/$missionId" params={{ missionId: outcome.missionId }} className="group flex items-center gap-1.5 self-start text-sm font-medium text-secondary">
          {outcome.status === "waiting" ? "See the mission it waits for" : "See the mission it started"}
          <ArrowRight size={14} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      ) : null}
      {said ? (
        <details open={failed} className="rounded-[14px] bg-base-200/60 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-semibold text-base-content/70">{failed ? "Why" : outcome.kind === "command" ? "What it printed" : "What it said"}</summary>
          <p className={cn("mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap text-base-content/85 [overflow-wrap:anywhere]", outcome.kind === "command" ? "font-mono text-xs" : "text-sm")}>
            {/* A mission it names is a link to that mission's page. */}
            <RunResult text={said} />
          </p>
        </details>
      ) : null}
    </div>
  );
}
