/**
 * A step's fields, opened in its own card: what it is called, what kind it is and that kind's own fields, and where
 * the run goes from it. Each path is a short dropdown: the next step, the end of the run, or a later step by its
 * number and title. Only later ones are offered, since a run only ever goes forward. The last step has no paths to
 * set: the run ends after it, and its card says how that end is counted.
 */

import { Undo2 } from "lucide-react";
import type { StepExit } from "@nouride/wire";
import { Field } from "@/commons/components/ui/ui";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import type { Then } from "../lib/draft";
import { DEFAULT_EXIT, KINDS, exitFrom, exitOf, exitValue, exitsOf, isLast, type ExitName, type ExitReset, type Step, type StepKind } from "../lib/steps";
import { KIND, endWords, exitAsks, exitChip, lastStepWords } from "../lib/words";
import { KindFields, type AgentChoice } from "./KindFields";

/** What a path can be set to from a step that is not the last: on, the end, or any step after it. */
function choices(steps: readonly Step[], index: number, exit: ExitName, titleOf: (step: Step) => string): { value: string; label: string }[] {
  return [
    { value: "next", label: `Go on to step ${index + 2}` },
    { value: "end", label: endWords(exit) },
    // The step right after it is "go on", said once.
    ...steps.slice(index + 2).map((step, at) => ({ value: exitValue({ to: step.id }), label: `Jump to step ${index + 3 + at}, ${titleOf(step)}` })),
  ];
}

/** A path as its dropdown holds it: a jump to the step right after is the same as going on. */
function held(steps: readonly Step[], index: number, exit: ExitName): string {
  const go = exitOf(steps[index]!, exit);
  return typeof go === "object" && steps[index + 1]?.id === go.to ? "next" : exitValue(go);
}

/** A path a move or a delete put back to its default, said on the step's card until it is read. */
export function ResetNotes({ step, resets, onForget }: { step: Step; resets: readonly ExitReset[]; onForget: (reset: ExitReset) => void }) {
  return (
    <>
      {resets.map((reset) => (
        <p key={reset.exit} role="status" className="flex flex-wrap items-center gap-2 rounded-[14px] bg-warning/10 px-3 py-2 text-xs text-warning">
          <Undo2 size={13} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1">
            "{exitChip(step, reset.exit)}" led to a step that {reset.why === "removed" ? "was deleted" : "is no longer after this one"}, so it is back to: {DEFAULT_EXIT[reset.exit] === "next" ? "go on" : endWords(reset.exit).toLowerCase()}.
          </span>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => onForget(reset)}>
            OK
          </button>
        </p>
      ))}
    </>
  );
}

export function StepEditor({
  steps,
  index,
  own,
  agents,
  alone,
  titleOf,
  onStep,
  onKind,
  onExit,
  onDone,
}: {
  steps: readonly Step[];
  index: number;
  own: string;
  agents: readonly AgentChoice[];
  alone: { then: Then; agent: string; onThen: (then: Then) => void } | null;
  titleOf: (step: Step) => string;
  onStep: (step: Step) => void;
  onKind: (kind: StepKind) => void;
  onExit: (exit: ExitName, go: StepExit) => void;
  onDone: () => void;
}) {
  const step = steps[index]!;
  const { name: _name, ...unnamed } = step;
  return (
    <div className="space-y-4 animate-fade">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" hint="Optional. What this step is called on its card.">
          <input className="input w-full text-sm" value={step.name ?? ""} maxLength={80} placeholder={titleOf(unnamed as Step)} onChange={(event) => onStep(event.target.value ? { ...step, name: event.target.value } : (unnamed as Step))} />
        </Field>
        <Field label="What it does">
          <SearchSelect label="What it does" align="start" className="w-full" options={KINDS.map((kind) => ({ value: kind, label: KIND[kind].label }))} value={step.kind} onChange={onKind} />
        </Field>
      </div>

      {/* Keyed by the kind as well: another kind's fields are another form, with nothing typed in it carried over unseen. */}
      <KindFields key={`${step.id} ${step.kind}`} step={step} own={own} agents={agents} alone={alone} onChange={onStep} />

      {isLast(steps, index) ? (
        // Nothing to choose: "Finish the run" stood here beside "End the run", two names for one thing.
        <p className="rounded-[18px] bg-base-200/60 p-3.5 text-xs text-base-content/75">{lastStepWords(step)}</p>
      ) : (
        <fieldset className="space-y-3 rounded-[18px] bg-base-200/60 p-3.5">
          <legend className="sr-only">Where the run goes from this step</legend>
          <p className="text-xs font-bold text-base-content/70">Where the run goes from here</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {exitsOf(step).map((exit) => (
              <Field key={exit} label={exitAsks(step, exit)}>
                <SearchSelect
                  label={exitAsks(step, exit)}
                  align="start"
                  className="w-full bg-base-100"
                  width={320}
                  options={choices(steps, index, exit, titleOf)}
                  value={held(steps, index, exit)}
                  onChange={(next) => onExit(exit, exitFrom(next))}
                />
              </Field>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex justify-end">
        <button type="button" className="btn btn-sm btn-ghost border border-base-content/10" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
