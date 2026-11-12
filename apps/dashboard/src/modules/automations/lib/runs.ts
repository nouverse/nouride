/**
 * One run read over an automation's steps: how each step went, which were never reached, and the path the run took
 * through the list. Pure (`tests/automation-runs.test.ts`); the page only draws what this says.
 *
 * A run of a list writes an outcome per step as it goes, so a run still at work can be read. A run of one thing writes
 * none: its one step went as the run did.
 */

import type { JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { landsAt, type ExitName, type Step } from "./steps";

export type RunStatus = JobRunSummary["status"];
export type StepStatus = StepRunOutcome["status"];

/** A run that is not over: at work, or waiting for a mission or a person. */
export const live = (run: Pick<JobRunSummary, "status"> | undefined): boolean => run?.status === "running" || run?.status === "waiting";

const OF_RUN: Record<RunStatus, StepStatus> = { success: "done", error: "failed", skipped: "skipped", interrupted: "interrupted", running: "running", waiting: "waiting" };

/** How each step went in a run, by the step's id. A step with no outcome was not reached. */
export function outcomesOf(steps: readonly Step[], run: JobRunSummary | undefined): Map<string, StepRunOutcome> {
  const outcomes = new Map<string, StepRunOutcome>();
  if (!run) return outcomes;
  if (run.steps) {
    for (const outcome of run.steps) outcomes.set(outcome.id, outcome);
    return outcomes;
  }
  const [only] = steps;
  if (steps.length !== 1 || !only) return outcomes;
  outcomes.set(only.id, {
    id: only.id,
    kind: only.kind,
    status: OF_RUN[run.status],
    ...(run.result ? { said: run.result } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { ms: run.finishedAt - run.startedAt } : {}),
  });
  return outcomes;
}

/** The exit a step left by, for how it went; none while it is at work or waiting, or when the run stopped in it. */
export function exitTaken(status: StepStatus): ExitName | null {
  if (status === "done") return "then";
  if (status === "failed" || status === "declined" || status === "expired") return "whenFailed";
  return status === "empty" ? "whenEmpty" : null;
}

/** One stretch of the path a run took: from a step, by one of its exits, to a later step or the run's end. */
export interface Leg {
  from: number;
  exit: ExitName;
  to: number | "end";
}

/** The path a run took through the list, a leg per step it left. */
export function pathTaken(steps: readonly Step[], run: JobRunSummary | undefined): Leg[] {
  const outcomes = outcomesOf(steps, run);
  return steps.flatMap((step, index): Leg[] => {
    const outcome = outcomes.get(step.id);
    const exit = outcome ? exitTaken(outcome.status) : null;
    return exit ? [{ from: index, exit, to: landsAt(steps, index, exit) }] : [];
  });
}

/** How long something took, to the unit a person reads: "0.4 s", "48 s", "3 min", "2 h". */
export function took(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/** What a chip of the run says, and its colour: mint for done, red for a failure only, pink for what waits on a person. */
export type Tone = "done" | "failed" | "quiet" | "working" | "needs";

/**
 * What waits for a person says: for the reader, in the colour of what needs them; or for whoever else answers it
 * (`whom`), on a page the reader only reads, where nothing is theirs to press.
 */
const waitsFor = (whom: string | undefined): { label: string; tone: Tone } => (whom ? { label: `Waiting for ${whom}`, tone: "quiet" } : { label: "Waiting for you", tone: "needs" });

export function outcomeWords(outcome: StepRunOutcome, whom?: string): { label: string; tone: Tone } {
  const after = outcome.ms !== undefined ? ` ${outcome.status === "done" ? "in" : "after"} ${took(outcome.ms)}` : "";
  switch (outcome.status) {
    case "done":
      return { label: `Done${after}`, tone: "done" };
    case "failed":
      return { label: `Failed${after}`, tone: "failed" };
    case "empty":
      return { label: "Nothing to say", tone: "quiet" };
    case "running":
      return { label: "Working", tone: "working" };
    case "waiting":
      return outcome.kind === "approval" ? waitsFor(whom) : { label: "Waiting for its mission", tone: "working" };
    case "declined":
      return { label: outcome.by ? `Stopped by ${outcome.by}` : "Stopped", tone: "quiet" };
    case "expired":
      return { label: "Nobody answered", tone: "quiet" };
    case "skipped":
      return { label: "Skipped", tone: "quiet" };
    case "interrupted":
      return { label: "Cut off by a restart", tone: "quiet" };
  }
}

/** A whole run in a word or two, for a list of runs. `whom`: who answers one that waits, where that is not the reader. */
export function runWords(run: Pick<JobRunSummary, "status" | "waiting">, whom?: string): { label: string; tone: Tone } {
  switch (run.status) {
    case "success":
      return { label: "Done", tone: "done" };
    case "error":
      return { label: "Failed", tone: "failed" };
    case "skipped":
      return { label: "Skipped", tone: "quiet" };
    case "interrupted":
      return { label: "Cut off by a restart", tone: "quiet" };
    case "running":
      return { label: "Working", tone: "working" };
    case "waiting":
      return run.waiting?.kind === "approval" ? waitsFor(whom) : { label: "Waiting for a mission", tone: "working" };
  }
}

/** How long a run took, or has taken so far. */
export const ranFor = (run: Pick<JobRunSummary, "startedAt" | "finishedAt">, now = Date.now()): number => (run.finishedAt ?? now) - run.startedAt;

const DAY = 86_400_000;
const midnight = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/** When something happened or will: "Today 09:40", "Yesterday 21:14", "Tomorrow 07:00", "1 Nov 09:00". */
export function whenWords(at: number, now = Date.now()): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((midnight(at) - midnight(now)) / DAY);
  if (days === 0) return `Today ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  const day = when.toLocaleDateString([], when.getFullYear() === new Date(now).getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${day} ${clock}`;
}
