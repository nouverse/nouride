/**
 * A kept plan, step by step (`plan`): each step with its state, a skipped one with why, and how far along it is. Drawn
 * in the Notes drawer under its task, and above the composer while the agent works (`PlanStrip.tsx`).
 */

import { Circle, CircleCheck, CircleDot, CircleSlash } from "lucide-react";
import type { NotesPlan, NotesPlanStep } from "@/commons/lib/api.notes";
import { stepsDone } from "../lib/notes";

/** Each state's mark and how its words read; the mark's tint is beside the mark, where it is plainly decoration. */
const STEP: Record<NotesPlanStep["state"], { icon: typeof Circle; text: string }> = {
  done: { icon: CircleCheck, text: "text-base-content/65" },
  active: { icon: CircleDot, text: "text-base-content font-medium" },
  pending: { icon: Circle, text: "text-base-content/85" },
  skipped: { icon: CircleSlash, text: "text-base-content/65" },
};

/** The plan kept with a task: each step with its state, a skipped one with why, and how far along it is. */
export function PlanSteps({ plan }: { plan: NotesPlan }) {
  return (
    <div className="rounded-lg border border-base-content/[0.06] bg-base-100/70 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-base-content/65">
        <span>Plan</span>
        <span>
          {stepsDone(plan.steps)} of {plan.steps.length} done
        </span>
      </div>
      <ol className="space-y-1">
        {plan.steps.map((step, index) => {
          const look = STEP[step.state];
          const Icon = look.icon;
          return (
            <li key={index} className="flex items-start gap-2 text-xs leading-relaxed">
              <Icon
                size={13}
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${{ done: "text-success", active: "text-primary", pending: "text-base-content/35", skipped: "text-base-content/45" }[step.state]}`}
              />
              <span className={`min-w-0 [overflow-wrap:anywhere] ${look.text}`}>
                <span className="sr-only">{step.state}: </span>
                {step.text}
                {step.state === "skipped" ? (
                  <span className="text-base-content/65">, skipped{step.reason ? `: ${step.reason}` : ""}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
