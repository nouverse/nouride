/**
 * A step's fields, beside the canvas or in its own box on a phone: what it is called, what kind it is and that kind's
 * own fields, the switch that lets the run go on only when what it says changed, and what the run does when the step
 * fails or has nothing to say, each asked as a question with a few answers (`PathChoices`).
 *
 * Where the run goes when the step is done is the canvas's own line and is not asked: on to the step drawn below. One
 * that goes elsewhere, as an automation written elsewhere can hold, keeps a field for it, so nothing it holds is out
 * of reach.
 *
 * A step of a lane answers for a failure too, with the two answers that need no drawing of their own (a stop, going
 * on), and where its lane ends is set here as well as on the step the lane hangs on: its fields said "set on that
 * step", and a person with the lane open did not find where.
 */

import { ArrowDown, ArrowUp, CopyPlus, Undo2 } from "lucide-react";
import type { StepExit } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Field } from "@/commons/components/ui/ui";
import type { Then } from "../lib/draft";
import { PATH_EXITS, chipExits, ruleOf, type Choice, type LaneEnds, type PathExit, type Paths, type Rule } from "../lib/paths";
import { DEFAULT_EXIT, KINDS, STEPS_MAX, canWatch, exitFrom, exitOf, exitValue, exitsOf, pickOf, watching, type ExitName, type ExitReset, type Step, type StepKind } from "../lib/steps";
import { KIND, PICK, endWords, exitAsks, exitChip, landingName, placeTitle, sameAgainWords } from "../lib/words";
import { KindFields, type AgentChoice, type ScriptContext } from "./KindFields";
import { FieldsFrame } from "./form-parts";
import { PathChoices } from "./PathChoices";
import { LaneEndPick, laneBackChoices } from "./PathRules";

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
function doneChoices(steps: readonly Step[], index: number, titleOf: (step: Step) => string, paths: Paths): { value: string; label: string }[] {
  return [
    { value: "next", label: "Go on to the next step" },
    { value: "end", label: endWords("then") },
    // Each by its place on the main line as drawn, as a chip names where it lands.
    ...steps.slice(index + 2).map((step, at) => ({ value: exitValue({ to: step.id }), label: `Jump to ${landingName(steps, index + 2 + at, titleOf, paths)}` })),
  ];
}

/**
 * Where the lane a step is in ends, set from that step: back into the main line at any step the run passes after the
 * one the lane hangs on, or a stop.
 */
function LaneEndField({ steps, paths, within, lane, titleOf, onSet }: { steps: readonly Step[]; paths: Paths; within: { owner: number; exit: PathExit }; lane: Extract<Rule, { kind: "lane" }>; titleOf: (step: Step) => string; onSet: (ends: LaneEnds) => void }) {
  return (
    <fieldset data-lane-end-field className="space-y-1.5">
      <legend className="mb-1.5 font-mono text-xs font-semibold tracking-wider text-base-content/85 uppercase">After these steps</legend>
      <LaneEndPick backs={laneBackChoices(steps, within.owner, lane, paths, titleOf)} onSet={onSet} />
      <p className="text-xs text-base-content/65">
        This step and the ones drawn with it run in place of {placeTitle(paths.line.indexOf(within.owner), titleOf(steps[within.owner]!))}: {exitChip(steps[within.owner]!, within.exit).toLowerCase()}.
      </p>
    </fieldset>
  );
}

/** What ends a step's fields: Delete, Done, and where no pointer hovers a box to show its menu, the same moves. */
function StepFoot({ place, last, full, onMove, onDuplicate, onRemove, onDone }: { place: number | null; last: number; full: boolean; onMove: ((by: -1 | 1) => void) | null; onDuplicate: (() => void) | null; onRemove: () => void; onDone: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className="btn btn-ghost btn-sm -ml-3 font-bold text-error" onClick={onRemove}>
        Delete step
      </button>
      {onMove ? (
        <div className="flex items-center gap-1 md:hidden">
          <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Move this step up" disabled={place === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={15} aria-hidden="true" />
          </button>
          <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Move this step down" disabled={place === last} onClick={() => onMove(1)}>
            <ArrowDown size={15} aria-hidden="true" />
          </button>
          {onDuplicate ? (
            <button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Duplicate this step" disabled={full} onClick={onDuplicate}>
              <CopyPlus size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="btn btn-primary btn-sm rounded-xl px-5" onClick={onDone}>
        Done
      </button>
    </div>
  );
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
  onOwnLaneEnd,
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
  onLaneEnd: (exit: PathExit, ends: LaneEnds) => void;
  /** Where the lane this step is in ends, set from the step itself. */
  onOwnLaneEnd: (ends: LaneEnds) => void;
  /** One place up or down the main line. None for a step of a lane. */
  onMove: ((by: -1 | 1) => void) | null;
  onDuplicate: (() => void) | null;
  onRemove: () => void;
  onDone: () => void;
}) {
  const step = steps[index]!;
  const { name: _name, ...unnamed } = step;
  const within = paths.inside.get(index);
  const lane = within ? ruleOf(paths, within.owner, within.exit) : undefined;
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
    <FieldsFrame
      mark={{ "data-step-fields": step.id }}
      head={
        <>
          <p className="font-mono text-xs font-semibold tracking-wider text-base-content/65 uppercase">
            {within ? `${exitChip(steps[within.owner]!, within.exit)} · ${PICK[pickOf(step)].label}` : `Step ${(place ?? 0) + 1} · ${PICK[pickOf(step)].label}`}
          </p>
          <h2 className="mt-0.5 line-clamp-2 text-lg text-base-content [overflow-wrap:anywhere]">{titleOf(step)}</h2>
        </>
      }
      foot={<StepFoot place={place} last={paths.line.length - 1} full={steps.length >= STEPS_MAX} onMove={onMove} onDuplicate={onDuplicate} onRemove={onRemove} onDone={onDone} />}
    >

      {/* Keyed by the kind as well: another kind's fields are another form, with nothing typed in it carried over unseen. */}
      <KindFields key={`${step.id} ${step.kind}`} step={step} own={own} agents={agents} alone={alone} script={script} onChange={(next) => onStep(index, next)} />

      {first.map(choices)}

      {within && lane?.kind === "lane" ? <LaneEndField steps={steps} paths={paths} within={within} lane={lane} titleOf={titleOf} onSet={onOwnLaneEnd} /> : null}

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
          {later.map(choices)}
          {ownDone ? (
            <Field label={exitAsks(step, "then")} hint="Set from elsewhere: the run does not go on to the step drawn below.">
              <SearchSelect
                label={exitAsks(step, "then")}
                align="start"
                className="w-full bg-base-100"
                width={320}
                options={doneChoices(steps, index, titleOf, paths)}
                value={typeof held === "object" && steps[index + 1]?.id === held.to ? "next" : exitValue(held)}
                onChange={(next) => onExit("then", exitFrom(next))}
              />
            </Field>
          ) : null}
        </div>
      </details>
    </FieldsFrame>
  );
}
