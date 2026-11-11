/**
 * Where the run goes from a step that says so for itself, under its card: one chip a path, "If it fails → step 4, Tell
 * me". What a step does by default (on when it is done, the end when it failed or said nothing) is not drawn: the line
 * to the next card already says it.
 *
 * A path that jumps past the next step is also a line at the flow's side (`FlowLinks`), from its chip to the card it
 * lands on. The chip is where that line is pointed at: the pointer or the focus on it lights the line and the card, and
 * a press brings the card into view. On a phone there is no room for the line, and the chip's words are the whole of it.
 */

import { ArrowRight, CornerDownRight } from "lucide-react";
import { cn } from "@/commons/lib/utils";
import { branchesOf, type ExitName, type Step } from "../lib/steps";
import { exitChip, exitGoes } from "../lib/words";

/** A step's card and a path's chip, as `FlowLinks` finds them, and a jump's own name. */
export const stepAnchor = (id: string): string => `step:${id}`;
export const exitAnchor = (id: string, exit: ExitName): string => `exit:${id}:${exit}`;
export const jumpKey = (id: string, exit: ExitName): string => `${id}:${exit}`;

export function Branches({
  steps,
  index,
  titleOf,
  active,
  onActive,
  taken,
  onShow,
}: {
  steps: readonly Step[];
  index: number;
  titleOf: (step: Step) => string;
  /** The jump the pointer or the focus is on, by its key. */
  active: string | null;
  onActive: (key: string | null) => void;
  /** Over a run: the path this step left by, or null when it left by none. Absent outside a run. */
  taken?: ExitName | null;
  /** Bring the step a path lands on into view. */
  onShow: (to: number) => void;
}) {
  const step = steps[index]!;
  const branches = branchesOf(steps, index);
  if (branches.length === 0) return null;
  return (
    <ul aria-label={`Where the run goes from step ${index + 1}`} className="mt-2 flex list-none flex-col items-start gap-1.5 pl-3 sm:pl-[3.75rem]">
      {branches.map(({ exit, to }) => {
        const key = jumpKey(step.id, exit);
        const lit = active === key;
        const went = taken === exit;
        // Over a run, a path it did not take is set back to plain: still read, no longer in the colour of a path.
        const passed = taken !== undefined && !went;
        const ink = went ? "text-success" : passed ? "text-base-content/65" : "text-secondary";
        return (
          <li key={exit} className="max-w-full">
            <button
              type="button"
              data-flow-anchor={exitAnchor(step.id, exit)}
              data-branch={exit}
              data-taken={went ? "" : undefined}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full border py-1 pr-3 pl-2 text-left text-xs transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-secondary/50",
                went ? "border-success/40 bg-success/15" : passed ? (lit ? "border-base-content/30 bg-base-100" : "border-base-content/10 bg-base-100") : lit ? "border-secondary/50 bg-secondary/20" : "border-secondary/20 bg-secondary/10",
              )}
              onMouseEnter={() => onActive(key)}
              onMouseLeave={() => onActive(null)}
              onFocus={() => onActive(key)}
              onBlur={() => onActive(null)}
              onClick={() => (to === "end" ? undefined : onShow(to))}
            >
              <CornerDownRight size={13} aria-hidden="true" className={cn("shrink-0", ink)} />
              <span className={cn("shrink-0 font-bold", ink)}>{exitChip(step, exit)}</span>
              <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-base-content/45" />
              <span className="min-w-0 truncate font-medium text-base-content/85">{exitGoes(steps, index, exit, titleOf)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
