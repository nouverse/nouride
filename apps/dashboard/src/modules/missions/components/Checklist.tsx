/**
 * The checklist the agent keeps with `plan`, each step with what it did and left (`note`) or why it was skipped. Every
 * turn of a mission starts from this rather than its history, so it is the mission's memory as much as its progress.
 */

import { useState } from "react";
import { Check, Circle, CircleDot, Minus } from "lucide-react";
import type { NotesPlan, NotesPlanStep } from "@nouride/wire";

const MARK: Record<NotesPlanStep["state"], { icon: typeof Check; tone: string; said: string }> = {
  done: { icon: Check, tone: "text-success", said: "done" },
  active: { icon: CircleDot, tone: "text-primary", said: "working on it" },
  pending: { icon: Circle, tone: "text-base-content/65", said: "to do" },
  skipped: { icon: Minus, tone: "text-base-content/65", said: "skipped" },
};

/** How many steps show before "Show all": a checklist of thirty pushed the turns, and on a phone everything, off the page. */
const STEPS_SHOWN = 5;

/**
 * Which steps show while the list is folded: the one at work with two on either side, so "how far is it" is answered
 * without opening it; with none at work, the first few. `from` is the first one's place in the whole list.
 */
export function stepsShown(steps: readonly NotesPlanStep[], open: boolean): { from: number; steps: readonly NotesPlanStep[] } {
  if (open || steps.length <= STEPS_SHOWN) return { from: 0, steps };
  const active = steps.findIndex((step) => step.state === "active");
  const from = active < 0 ? 0 : Math.min(Math.max(0, active - 2), steps.length - STEPS_SHOWN);
  return { from, steps: steps.slice(from, from + STEPS_SHOWN) };
}

export function Checklist({ plan }: { plan: NotesPlan | null }) {
  const [open, setOpen] = useState(false);
  if (!plan || plan.steps.length === 0) {
    return <p className="text-sm text-base-content/65">No checklist yet. Writing one is the first thing a mission does.</p>;
  }
  const shown = stepsShown(plan.steps, open);
  return (
    <div className="space-y-2" data-checklist={open ? "open" : "folded"}>
      <ol className="space-y-1">
        {shown.steps.map((step, at) => {
          const index = shown.from + at;
          const mark = MARK[step.state] ?? MARK.pending;
          const Icon = mark.icon;
          return (
            <li
              key={`${index}-${step.text}`}
              className={`flex gap-3 rounded-xl px-2.5 py-2 ${step.state === "active" ? "bg-primary/[0.06] ring-1 ring-primary/20" : ""}`}
            >
              <span className={`mt-0.5 shrink-0 ${mark.tone}`}>
                <Icon size={15} aria-hidden="true" />
                <span className="sr-only">{mark.said}: </span>
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm leading-snug [overflow-wrap:anywhere] ${step.state === "skipped" ? "text-base-content/65 line-through decoration-base-content/30" : "text-base-content"}`}>
                  <span className="mr-1.5 font-mono text-[11px] text-base-content/65 tabular-nums">{index + 1}.</span>
                  {step.text}
                </p>
                {step.note && <p className="mt-0.5 text-xs leading-relaxed text-base-content/70 [overflow-wrap:anywhere]">{step.note}</p>}
                {step.state === "skipped" && step.reason && <p className="mt-0.5 text-xs text-base-content/65">skipped: {step.reason}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {plan.steps.length > STEPS_SHOWN ? (
        <button type="button" className="btn btn-ghost btn-sm min-h-11 w-full rounded-xl border border-dashed border-base-content/15 sm:min-h-8" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? "Show less" : `Show all ${plan.steps.length} steps`}
        </button>
      ) : null}
    </div>
  );
}
