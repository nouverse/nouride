/**
 * An agent at work, in one line: what it is doing now, how many steps it has taken and for how long — "exec df -h ·
 * 9 steps · 42s". The steps still arrive as they happen; the line shows the newest, and a press opens the whole list
 * (`StepFeed`) under it, another closes it. A turn of forty calls used to fill the screen while it ran; the answer it
 * was writing is what a person waits for.
 *
 * The line keeps its height whatever it says, and the count and the clock keep their width, so nothing below it moves
 * while it streams.
 */

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { TurnStep } from "@nouride/wire";
import { StepFeed } from "@/commons/components/turns/Steps";
import { countedSteps, formatElapsed, stepRows, workSteps } from "@/commons/lib/steps";
import { cn } from "@/commons/lib/utils";

/** What the line says the agent is doing: its newest call, or that it is thinking before its first. */
function newestStep(steps: TurnStep[]): string {
  const rows = stepRows(steps);
  const latest = rows.at(-1);
  if (latest) return latest.text;
  return workSteps(steps).at(-1)?.kind === "reasoning" ? "Thinking it through" : "Thinking…";
}

export function LiveStepLine({ steps, elapsedMs, running }: { steps: TurnStep[]; elapsedMs: number; running: boolean }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const counted = countedSteps(steps).length;
  return (
    <div className="flex w-full max-w-xl flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen((was) => !was)}
        className="flex h-11 max-w-full items-center gap-2.5 self-start rounded-xl border border-base-content/[0.1] bg-base-100 px-3 text-[13px] text-base-content outline-none transition-colors hover:bg-base-200/60 focus-visible:ring-2 focus-visible:ring-secondary/60 sm:h-10"
      >
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full text-success", running ? "halo animate-pulse bg-success" : "bg-success/70")} />
        <span className="sr-only">{running ? "Working:" : "Finished:"}</span>
        <span className="min-w-0 truncate font-semibold">{running ? newestStep(steps) : "Finished"}</span>
        <span className="shrink-0 tabular-nums text-base-content/65">
          · {counted} {counted === 1 ? "step" : "steps"} · {formatElapsed(elapsedMs)}
        </span>
        <span className="hidden shrink-0 font-semibold text-secondary sm:inline">{open ? "Hide steps" : "Show steps"}</span>
        <ChevronDown size={16} aria-hidden="true" className={cn("shrink-0 text-secondary transition-transform duration-150", open && "rotate-180")} />
      </button>
      <div id={list} hidden={!open}>
        {open ? <StepFeed steps={steps} elapsedMs={elapsedMs} running={running} bare /> : null}
      </div>
    </div>
  );
}
