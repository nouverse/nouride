/**
 * One step of the main line with what hangs on it: its box, its own rules as a strip in that box, the lanes that run in
 * its place at its side, and a chip for a path the canvas has no drawing for (`lib/paths.ts`).
 *
 * The same box three ways, by what the page is showing: being edited (a press opens its fields beside the canvas, or in
 * the box on a phone; a handle and a menu show when the pointer or the focus is on it), over a run (how it went, or that
 * the run never reached it), or only read (a change an agent suggested, with what it would add, change and remove
 * marked).
 */

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, CopyPlus, Ellipsis, GripVertical, Plus, Trash2 } from "lucide-react";
import type { JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import type { Grip } from "@/commons/components/ui/ReorderList";
import { Tag } from "@/commons/components/ui/Tag";
import { cn } from "@/commons/lib/utils";
import type { Editor } from "../hooks/use-editor";
import { chipExits, type Paths, type PathExit, type Rule } from "../lib/paths";
import { exitTaken, outcomeWords, type Tone } from "../lib/runs";
import { STEPS_MAX, type Step } from "../lib/steps";
import type { Mark } from "../lib/suggested";
import { KIND, exitChip, partTitle, stepFacts, stepLine } from "../lib/words";
import { Branches, stepAnchor } from "./Branches";
import type { AgentChoice } from "./KindFields";
import { FactStrip, LaneEnd, LaneLine, RuleStrip } from "./PathRules";
import { ScriptRead } from "./ScriptFields";
import { StepBox, type BoxLook } from "./StepBox";
import { ResetNotes } from "./StepFields";
import { StepRun } from "./StepRun";

/** What the flow is showing, and what each way of showing it needs. */
export type FlowMode =
  | {
      kind: "edit";
      editor: Editor;
      agents: readonly AgentChoice[];
      /** What is wrong with a step, by its place, as a save would be refused for. */
      problems: ReadonlyMap<number, string>;
      /** The step the server refused the last save for, and its words. */
      refused: { index: number; message: string } | null;
      onRemove: (index: number) => void;
    }
  | {
      kind: "run";
      run: JobRunSummary;
      outcomes: ReadonlyMap<string, StepRunOutcome>;
      /** The automation's name, for an answer's toast. */
      name: string;
      /** What the step before said, for the step that waits for a person. */
      before?: string | undefined;
      canAnswer: boolean;
      /** Who answers a step that waits for a person, where that is not the reader: on a page they only read. */
      whom?: string | undefined;
    }
  | { kind: "read" };

/** What opens in a box in place of beside the canvas, on a screen with no room beside it: whose it is, and the fields. */
export interface Inline {
  key: string;
  node: ReactNode;
}

const MARKS: Record<Mark, { tag: string; state: BoxLook | undefined }> = {
  added: { tag: "Suggested", state: "suggested" },
  changed: { tag: "Would change", state: undefined },
  removed: { tag: "Would be removed", state: "leaving" },
};

const OF_TONE: Record<Tone, BoxLook | undefined> = { done: "done", failed: "failed", quiet: undefined, working: "working", needs: "needs" };

const ITEM = "min-h-10 gap-3 rounded-xl text-sm";

function StepMenu({ index, place, grip, full, editor, onRemove }: { index: number; place: number; grip: Grip; full: boolean; editor: Editor; onRemove: (index: number) => void }) {
  return (
    <DropdownMenu
      trigger={<Ellipsis size={16} aria-hidden="true" />}
      triggerClassName="btn btn-ghost btn-square btn-sm text-base-content/65 hover:text-base-content"
      ariaLabel={`More for step ${place + 1}`}
      width={208}
      menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
    >
      {(close) => {
        const item = (label: string, Icon: typeof ArrowUp, act: () => void, more: { disabled?: boolean; danger?: boolean } = {}) => (
          <li>
            <button
              type="button"
              className={cn(ITEM, more.danger && "text-error")}
              disabled={more.disabled}
              onClick={() => {
                close();
                act();
              }}
            >
              <Icon size={15} aria-hidden="true" /> {label}
            </button>
          </li>
        );
        return (
          <>
            {item("Move up", ArrowUp, () => grip.move(-1), { disabled: grip.first })}
            {item("Move down", ArrowDown, () => grip.move(1), { disabled: grip.last })}
            {item("Duplicate", CopyPlus, () => editor.duplicate(index), { disabled: full })}
            {item("Delete", Trash2, () => onRemove(index), { danger: true })}
          </>
        );
      }}
    </DropdownMenu>
  );
}

interface Shared {
  steps: readonly Step[];
  paths: Paths;
  /** The automation's own agent's name. */
  ownName: string;
  /** The agent a lone command hands what it printed to, where it does. */
  reads?: string | undefined;
  agentName: (id: string) => string;
  mode: FlowMode;
  /** What a suggested change would do to each step, by its id. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** The step a jump under the pointer lands on, by its anchor. */
  landsOn: string | null;
  active: string | null;
  onActive: (key: string | null) => void;
  onShow: (to: number) => void;
  titleOf: (step: Step) => string;
  inline: Inline | null;
}

/**
 * A row of the canvas. A canvas with a lane lays every row out with room for one at its side, where the canvas itself
 * has that room: a box of 20rem, the lane's line of 4.5rem and a lane of 15rem are 39.5rem, which a window of 1440px
 * leaves the canvas with a scrollbar drawn. Asked of the canvas (`@container/flow` on it) and not of the window: at a
 * window of 1280px, with the menu and the panel beside it, the canvas had 508px, and both columns were squeezed until
 * a box's title broke in three. Short of that room a lane hangs under its step, set in.
 */
export const PLAIN_ROW = "mx-auto w-full max-w-[21rem]";
export const LANED_ROW = `${PLAIN_ROW} @[39.5rem]/flow:grid @[39.5rem]/flow:max-w-none @[39.5rem]/flow:grid-cols-[20rem_15rem] @[39.5rem]/flow:justify-center @[39.5rem]/flow:gap-x-[4.5rem]`;

/** One step's box, on the main line or in a lane, as the page is showing it. */
function Box({ index, place, side, grip, shared }: { index: number; place: number | null; side: boolean; grip?: Grip | undefined; shared: Shared }) {
  const { steps, paths, mode, titleOf, agentName, ownName } = shared;
  const step = steps[index]!;
  const look = KIND[step.kind];
  const mark = shared.marks?.get(step.id);
  const marked = mark ? MARKS[mark] : null;
  const landed = shared.landsOn === stepAnchor(step.id);
  const rules = (paths.rules.get(index) ?? []).filter((rule): rule is Extract<Rule, { kind: "goOn" | "ask" }> => rule.kind !== "lane");
  const outcomeOf = (id: string) => (mode.kind === "run" ? mode.outcomes.get(id) : undefined);
  const outcome = outcomeOf(step.id);
  const left = outcome ? exitTaken(outcome.status) : null;
  // A question folded into this box that a save would be refused for: said here, since its own box is not drawn.
  const lacks = (rule: Rule): string | undefined => (mode.kind === "edit" && rule.kind === "ask" ? mode.problems.get(rule.at) : undefined);
  // `reads` is there only for an automation that is one command and no list: among other steps the next step reads it.
  const facts = stepFacts(step, shared.reads);
  const strip =
    rules.length + facts.length > 0 ? (
      <>
        {facts.map((fact) => (
          <FactStrip key={fact}>{fact}</FactStrip>
        ))}
        {rules.map((rule) => (
          <RuleStrip key={rule.exit} step={step} rule={rule} question={rule.kind === "ask" ? (steps[rule.at] as Extract<Step, { kind: "approval" }>).ask : undefined} taken={left === rule.exit} lacking={lacks(rule) !== undefined} />
        ))}
      </>
    ) : null;
  const tag = marked ? <Tag tone={mark === "removed" ? "plain" : "needs"}>{marked.tag}</Tag> : null;
  const head = { title: titleOf(step), line: stepLine(step, agentName), mono: step.kind === "command" && !step.script, icon: look.icon, tile: look.tile, anchor: stepAnchor(step.id), side, strip, badge: tag };

  if (mode.kind === "run") {
    // Each of several at the same time, by the name its words are joined under; one no longer in the list keeps its id.
    const partTitleOf = (id: string): string => {
      const part = step.kind === "parallel" ? step.steps.find((one) => one.id === id) : undefined;
      return part ? partTitle(part, part.kind === "agentTurn" && part.agentId ? agentName(part.agentId) : ownName) : id;
    };
    return (
      <StepBox {...head} state={outcome ? (landed ? "target" : OF_TONE[outcomeWords(outcome, mode.whom).tone]) : undefined} dimmed={!outcome}>
        {outcome ? <StepRun outcome={outcome} run={mode.run} name={mode.name} before={mode.before} canAnswer={mode.canAnswer} whom={mode.whom} partTitle={partTitleOf} /> : <p className="text-xs text-base-content/65">Not reached in this run</p>}
      </StepBox>
    );
  }

  // Nothing of it is changed here, and a script is still read: one an agent proposed is agreed to by its text.
  if (mode.kind === "read") {
    return (
      <StepBox {...head} state={landed ? "target" : marked?.state}>
        {step.kind === "command" && step.script ? <ScriptRead step={{ ...step, script: step.script }} agentName={agentName} /> : null}
      </StepBox>
    );
  }

  const { editor } = mode;
  const open = editor.open === step.id;
  const resets = editor.resets.filter((reset) => reset.id === step.id);
  // A step still being written is not told what it lacks; one left behind is, and one the server refused always.
  const problem = mode.refused?.index === index ? mode.refused.message : open ? undefined : (mode.problems.get(index) ?? (paths.rules.get(index) ?? []).map(lacks).find(Boolean));
  const here = shared.inline?.key === step.id ? shared.inline.node : null;
  const number = place === null ? `the side step “${titleOf(step)}”` : `step ${place + 1}`;
  return (
    <StepBox
      {...head}
      state={problem ? "lacking" : open ? "open" : landed ? "target" : marked?.state}
      className={cn(grip?.held && "scale-[1.015] shadow-xl")}
      onPress={() => editor.setOpen(open ? null : step.id)}
      pressLabel={`${open ? "Close" : "Edit"} ${number}: ${titleOf(step)}`}
      expanded={open}
      hover={
        grip && place !== null ? (
          <>
            {paths.line.length > 1 ? (
              <button {...grip.handle} className={cn("grid size-8 place-items-center rounded-lg text-base-content/65 outline-none hover:text-base-content focus-visible:ring-2 focus-visible:ring-secondary/50", grip.handle.className)}>
                <GripVertical size={16} aria-hidden="true" />
              </button>
            ) : null}
            <StepMenu index={index} place={place} grip={grip} full={steps.length >= STEPS_MAX} editor={editor} onRemove={mode.onRemove} />
          </>
        ) : null
      }
    >
      {problem || resets.length > 0 || here ? (
        <div className="space-y-3">
          {problem ? (
            <p role="alert" className="text-sm font-medium text-error">
              {problem}
            </p>
          ) : null}
          <ResetNotes step={step} resets={resets} onForget={editor.forget} />
          {here}
        </div>
      ) : null}
    </StepBox>
  );
}

/** A lane: the steps that run in a step's place, under the path's name, and the mark it ends in. */
function Lane({ owner, rule, shared, onAdd }: { owner: number; rule: Extract<Rule, { kind: "lane" }>; shared: Shared; onAdd?: ((owner: number, exit: PathExit) => (button: HTMLButtonElement) => void) | undefined }) {
  const { steps, mode, titleOf } = shared;
  const step = steps[owner]!;
  const went = (id: string) => (mode.kind === "run" ? mode.outcomes.get(id) : undefined);
  const leftBy = went(step.id) ? exitTaken(went(step.id)!.status) : null;
  const taken = leftBy === rule.exit;
  const name = exitChip(step, rule.exit);
  return (
    <section data-lane={rule.exit} data-taken={taken ? "" : undefined} aria-label={`${name}: what runs in its place`} className="relative">
      {/* The line from the step's box to its lane, where the lane stands at its side. */}
      <span aria-hidden="true" className={cn("absolute top-8 -left-[4.5rem] w-[4.5rem] border-t-2 border-dashed @max-[39.5rem]/flow:hidden", taken ? "border-success" : "border-secondary/40")} />
      <p className={cn("text-xs font-bold @max-[39.5rem]/flow:mb-1.5 @[39.5rem]/flow:absolute @[39.5rem]/flow:top-2.5 @[39.5rem]/flow:-left-[4.5rem] @[39.5rem]/flow:w-[4.5rem] @[39.5rem]/flow:text-center", taken ? "text-success" : "text-secondary")}>{name}</p>
      {rule.lane.map((at, n) => (
        <div key={steps[at]!.id}>
          {n > 0 ? <LaneLine taken={went(steps[rule.lane[n - 1]!]!.id)?.status === "done"} /> : null}
          <Box index={at} place={null} side shared={shared} />
          <Branches steps={steps} index={at} exits={chipExits(steps, at, shared.paths)} titleOf={titleOf} active={shared.active} onActive={shared.onActive} onShow={shared.onShow} {...(mode.kind === "run" ? { taken: went(steps[at]!.id) ? exitTaken(went(steps[at]!.id)!.status) : null } : {})} />
        </div>
      ))}
      {onAdd ? (
        <button
          type="button"
          aria-label={`Add a step to what runs ${name.charAt(0).toLowerCase()}${name.slice(1)}`}
          className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-base-content/25 bg-base-100 px-3 text-xs font-bold text-base-content/75 transition-colors hover:border-secondary/40 hover:text-secondary"
          onClick={(event) => onAdd(owner, rule.exit)(event.currentTarget)}
        >
          <Plus size={13} strokeWidth={2.5} aria-hidden="true" /> Add a step
        </button>
      ) : null}
      <LaneEnd ends={rule.ends === "stop" ? "stop" : "back"} title={rule.ends === "stop" ? undefined : titleOf(steps[rule.ends.back]!)} />
    </section>
  );
}

export function StepItem({
  index,
  place,
  grip,
  wide,
  onLaneAdd,
  ...shared
}: Shared & {
  /** Its place in the list, and on the main line as drawn. */
  index: number;
  place: number;
  grip: Grip;
  /** Some step of the canvas has a lane: every row is laid out with room for one at its side. */
  wide: boolean;
  /** A step added at a lane's end, from the button it was pressed on. None outside editing, or where the list is full. */
  onLaneAdd?: ((owner: number, exit: PathExit) => (button: HTMLButtonElement) => void) | undefined;
}) {
  const { steps, paths, mode } = shared;
  const lanes = (paths.rules.get(index) ?? []).filter((rule): rule is Extract<Rule, { kind: "lane" }> => rule.kind === "lane");
  const outcome = mode.kind === "run" ? mode.outcomes.get(steps[index]!.id) : undefined;
  return (
    <div className={wide ? LANED_ROW : PLAIN_ROW}>
      <div className="flex min-w-0 flex-col">
        <Box index={index} place={place} side={false} grip={grip} shared={shared} />
        <Branches steps={steps} index={index} exits={chipExits(steps, index, paths)} titleOf={shared.titleOf} active={shared.active} onActive={shared.onActive} onShow={shared.onShow} {...(mode.kind === "run" ? { taken: outcome ? exitTaken(outcome.status) : null } : {})} />
        {/* Beside a lane taller than its step, the main line runs on down to the next box. */}
        {lanes.length > 0 ? <div aria-hidden="true" className="mx-auto w-0.5 flex-1 rounded-full bg-base-content/15 @max-[39.5rem]/flow:hidden" /> : null}
      </div>
      {lanes.length > 0 ? (
        <div className="space-y-4 @max-[39.5rem]/flow:mt-2.5 @max-[39.5rem]/flow:ml-6 @max-[39.5rem]/flow:border-l-2 @max-[39.5rem]/flow:border-dashed @max-[39.5rem]/flow:border-secondary/30 @max-[39.5rem]/flow:pl-3">
          {lanes.map((rule) => (
            <Lane key={rule.exit} owner={index} rule={rule} shared={shared} onAdd={onLaneAdd} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
