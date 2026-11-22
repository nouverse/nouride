/**
 * A step's fields, beside the canvas or in its own box on a phone: what it is called, what kind it is and that kind's
 * own fields, the switch that lets the run go on only when what it says changed, and what the run does when the step
 * fails or has nothing to say, each asked as a question with a few answers (`PathChoices`).
 *
 * Where the run goes when the step is done is the canvas's own line and is not asked: on to the step drawn below. One
 * that goes elsewhere, as an automation written elsewhere can hold, keeps a field for it, so nothing it holds is out
 * of reach.
 *
 * A step of a lane has no paths of its own to choose here: it runs in another step's place, and where its lane ends is
 * that step's to say.
 */

import { ArrowDown, ArrowUp, CopyPlus, Undo2 } from "lucide-react";
import type { StepExit } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Field } from "@/commons/components/ui/ui";
import type { Then } from "../lib/draft";
import { PATH_EXITS, chipExits, type Choice, type PathExit, type Paths } from "../lib/paths";
import { DEFAULT_EXIT, KINDS, STEPS_MAX, canWatch, exitFrom, exitOf, exitValue, exitsOf, watching, type ExitName, type ExitReset, type Step, type StepKind } from "../lib/steps";
import { KIND, endWords, exitAsks, exitChip, sameAgainWords } from "../lib/words";
import { KindFields, type AgentChoice, type ScriptContext } from "./KindFields";
import { PathChoices } from "./PathChoices";

/** A path a move or a delete put back to its default, said on the step's box until it is read. */
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

/** What "when it is done" can be set to, for a step that says its own: on, the end, or any step after it. */
function doneChoices(steps: readonly Step[], index: number, titleOf: (step: Step) => string): { value: string; label: string }[] {
  return [
    { value: "next", label: "Go on to the next step" },
    { value: "end", label: endWords("then") },
    ...steps.slice(index + 2).map((step, at) => ({ value: exitValue({ to: step.id }), label: `Jump to step ${index + 3 + at}, ${titleOf(step)}` })),
  ];
}

export function StepFields({
  steps,
  index,
  place,
  paths,
  own,
  agents,
  alone,
  script,
  titleOf,
  onStep,
  onKind,
  onExit,
  onChoose,
  onLaneEnd,
  onMove,
  onDuplicate,
  onRemove,
  onDone,
}: {
  steps: readonly Step[];
  index: number;
  /** Its place on the main line as drawn; null for a step of a lane. */
  place: number | null;
  paths: Paths;
  own: string;
  agents: readonly AgentChoice[];
  alone: { then: Then; agent: string; onThen: (then: Then) => void } | null;
  script: ScriptContext;
  titleOf: (step: Step) => string;
  onStep: (index: number, step: Step) => void;
  onKind: (kind: StepKind) => void;
  onExit: (exit: ExitName, go: StepExit) => void;
  onChoose: (exit: PathExit, choice: Exclude<Choice, "jump">) => void;
  onLaneEnd: (exit: PathExit, ends: "stop" | "back") => void;
  /** One place up or down the main line. None for a step of a lane. */
  onMove: ((by: -1 | 1) => void) | null;
  onDuplicate: (() => void) | null;
  onRemove: () => void;
  onDone: () => void;
}) {
  const step = steps[index]!;
  const { name: _name, ...unnamed } = step;
  const within = paths.inside.get(index);
  const asked = PATH_EXITS.filter((exit) => exitsOf(step).includes(exit));
  // Said only where it says something the canvas does not draw: a step that ends the run early, or jumps ahead.
  const ownDone = chipExits(steps, index, paths).includes("then");
  const held = exitOf(step, "then");
  // What a failure does is asked of every step, in the open. Silence is the rarer question: with the rest, unless it
  // is set to something.
  const first = asked.filter((exit) => exit === "whenFailed");
  const later = asked.filter((exit) => exit !== "whenFailed");
  const moreSet = ownDone || step.onlyChanged === true || later.some((exit) => step[exit] !== undefined);
  const choices = (exit: PathExit) => (
    <PathChoices
      key={exit}
      steps={steps}
      index={index}
      exit={exit}
      paths={paths}
      titleOf={titleOf}
      onChoose={(choice) => onChoose(exit, choice)}
      onQuestion={(at, ask) => onStep(at, { ...(steps[at] as Extract<Step, { kind: "approval" }>), ask })}
      onLaneEnd={(ends) => onLaneEnd(exit, ends)}
    />
  );
  return (
    <div className="space-y-4" data-step-fields={step.id}>
      <header>
        <p className="font-mono text-xs font-semibold tracking-wider text-base-content/65 uppercase">
          {within ? `${exitChip(steps[within.owner]!, within.exit)} · ${KIND[step.kind].label}` : `Step ${(place ?? 0) + 1} · ${KIND[step.kind].label}`}
        </p>
        <h2 className="mt-0.5 text-lg text-base-content [overflow-wrap:anywhere]">{titleOf(step)}</h2>
      </header>

      {/* Keyed by the kind as well: another kind's fields are another form, with nothing typed in it carried over unseen. */}
      <KindFields key={`${step.id} ${step.kind}`} step={step} own={own} agents={agents} alone={alone} script={script} onChange={(next) => onStep(index, next)} />

      {within ? (
        <p className="rounded-[18px] bg-base-200/60 p-3.5 text-xs text-base-content/75">
          It runs in place of “{titleOf(steps[within.owner]!)}” when that step takes this path. Where the run goes after it is set on that step.
        </p>
      ) : (
        first.map(choices)
      )}

      {/* What is set once and seldom looked at again: open where one of them is not as a new step has it. */}
      <details className="group/more rounded-[18px] bg-base-200/60" open={moreSet}>
        <summary className="cursor-pointer list-none px-3.5 py-2.5 text-sm font-semibold text-base-content/80 select-none [&::-webkit-details-marker]:hidden">
          More about this step
          <span aria-hidden="true" className="float-right text-base-content/50 transition-transform group-open/more:rotate-180">⌄</span>
        </summary>
        <div className="space-y-4 px-3.5 pb-3.5">
          <Field label="Name" hint="Optional. What its box is called.">
            <input className="input w-full text-sm" value={step.name ?? ""} maxLength={80} placeholder={titleOf(unnamed as Step)} onChange={(event) => onStep(index, event.target.value ? { ...step, name: event.target.value } : (unnamed as Step))} />
          </Field>
          <Field label="Kind of step">
            <SearchSelect label="Kind of step" align="start" className="w-full bg-base-100" options={KINDS.map((kind) => ({ value: kind, label: KIND[kind].label }))} value={step.kind} onChange={onKind} />
          </Field>
          {canWatch(step) ? <ToggleRow label="Go on only when this changes" hint={sameAgainWords(steps, index)} checked={step.onlyChanged === true} onChange={(on) => onStep(index, watching(step, on))} /> : null}
          {within ? null : later.map(choices)}
          {ownDone ? (
            <Field label={exitAsks(step, "then")} hint="Set from elsewhere: the run does not go on to the step drawn below.">
              <SearchSelect
                label={exitAsks(step, "then")}
                align="start"
                className="w-full bg-base-100"
                width={320}
                options={doneChoices(steps, index, titleOf)}
                value={typeof held === "object" && steps[index + 1]?.id === held.to ? "next" : exitValue(held)}
                onChange={(next) => onExit("then", exitFrom(next))}
              />
            </Field>
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <button type="button" className="btn btn-ghost btn-sm -ml-3 font-bold text-error" onClick={onRemove}>
          Delete step
        </button>
        {/* Where no pointer hovers a box to show its menu: the same moves, in its fields. */}
        {onMove ? (
          <div className="flex items-center gap-1 md:hidden">
            <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Move this step up" disabled={place === 0} onClick={() => onMove(-1)}>
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Move this step down" disabled={place === paths.line.length - 1} onClick={() => onMove(1)}>
              <ArrowDown size={15} aria-hidden="true" />
            </button>
            {onDuplicate ? (
              <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Duplicate this step" disabled={steps.length >= STEPS_MAX} onClick={onDuplicate}>
                <CopyPlus size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="btn btn-primary btn-sm rounded-xl px-5" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
