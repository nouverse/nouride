/**
 * One step in the flow: its card, and under it the paths it says for itself. The same card three ways, by what the page
 * is showing: being edited (a handle to drag it by, a menu to move, copy or delete it, its fields opened in place), over
 * a run (how it went, or that the run never reached it), or only read (a change an agent suggested, with what it would
 * add, change and remove marked).
 */

import { ArrowDown, ArrowUp, CopyPlus, Ellipsis, GripVertical, Pencil, Trash2, X } from "lucide-react";
import type { JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { StepCard, type StepCardState } from "@/commons/components/jobs/StepCard";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import type { Grip } from "@/commons/components/ui/ReorderList";
import { Tag } from "@/commons/components/ui/Tag";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { cn } from "@/commons/lib/utils";
import type { Editor } from "../hooks/use-editor";
import { savesAsList, type Then } from "../lib/draft";
import { exitTaken, outcomeWords, type Tone } from "../lib/runs";
import { STEPS_MAX, type Step } from "../lib/steps";
import type { Mark } from "../lib/suggested";
import { KIND, stepLine, stepNote } from "../lib/words";
import { Branches, stepAnchor } from "./Branches";
import type { AgentChoice } from "./KindFields";
import { ResetNotes, StepEditor } from "./StepEditor";
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
    }
  | { kind: "read" };

const MARKS: Record<Mark, { tag: string; state: StepCardState | undefined }> = {
  added: { tag: "Suggested", state: "suggested" },
  changed: { tag: "Would change", state: undefined },
  removed: { tag: "Would be removed", state: "leaving" },
};

const OF_TONE: Record<Tone, StepCardState | undefined> = { done: "done", failed: "failed", quiet: undefined, working: "working", needs: "needs" };

/** Whose step it is, as its cat: for a step an agent does. */
function StepFace({ agentId }: { agentId: string }) {
  const face = useAgentFace(agentId);
  return face?.look ? <AgentAvatar look={face.look} name={face.name} size="xs" /> : null;
}

const ITEM = "min-h-10 gap-3 rounded-xl text-sm";

function StepMenu({ index, grip, full, editor, onRemove }: { index: number; grip: Grip; full: boolean; editor: Editor; onRemove: (index: number) => void }) {
  return (
    <DropdownMenu
      trigger={<Ellipsis size={16} aria-hidden="true" />}
      triggerClassName="btn btn-ghost btn-square btn-sm text-base-content/65 hover:text-base-content"
      ariaLabel={`More for step ${index + 1}`}
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

export function StepItem({
  steps,
  index,
  own,
  ownName,
  mode,
  grip,
  mark,
  landed,
  active,
  onActive,
  onShow,
  titleOf,
}: {
  steps: readonly Step[];
  index: number;
  /** The automation's own agent, and what it is called. */
  own: string;
  ownName: string;
  mode: FlowMode;
  grip: Grip;
  /** What a suggested change would do to this step. */
  mark?: Mark | undefined;
  /** A jump under the pointer lands on this card. */
  landed: boolean;
  active: string | null;
  onActive: (key: string | null) => void;
  onShow: (to: number) => void;
  titleOf: (step: Step) => string;
}) {
  const step = steps[index]!;
  const look = KIND[step.kind];
  const does = step.kind === "agentTurn" || step.kind === "mission" ? (step.agentId ?? own) : null;
  const marked = mark ? MARKS[mark] : null;
  const head = { eyebrow: `Step ${index + 1}`, title: titleOf(step), line: stepLine(step), mono: step.kind === "command", icon: look.icon, tile: look.tile, anchor: stepAnchor(step.id) };
  const face = does ? <StepFace agentId={does} /> : null;
  const tag = marked ? <Tag tone={mark === "removed" ? "plain" : "needs"}>{marked.tag}</Tag> : null;
  const branches = (taken?: ReturnType<typeof exitTaken>) => <Branches steps={steps} index={index} titleOf={titleOf} active={active} onActive={onActive} onShow={onShow} {...(taken === undefined ? {} : { taken })} />;

  if (mode.kind === "run") {
    const outcome = mode.outcomes.get(step.id);
    return (
      <>
        <StepCard {...head} whole={outcome?.status === "waiting"} state={outcome ? (landed ? "target" : OF_TONE[outcomeWords(outcome).tone]) : undefined} dimmed={!outcome} aside={face}>
          {outcome ? <StepRun outcome={outcome} run={mode.run} name={mode.name} before={mode.before} canAnswer={mode.canAnswer} /> : <p className="text-xs text-base-content/65">Not reached in this run</p>}
        </StepCard>
        {branches(outcome ? exitTaken(outcome.status) : null)}
      </>
    );
  }

  if (mode.kind === "read") {
    return (
      <>
        <StepCard {...head} note={stepNote(step, index)} state={landed ? "target" : marked?.state} badge={tag} aside={face} />
        {branches()}
      </>
    );
  }

  const { editor } = mode;
  const open = editor.open === step.id;
  const resets = editor.resets.filter((reset) => reset.id === step.id);
  // A step still being written is not told what it lacks; one left behind is, and one the server refused always.
  const problem = mode.refused?.index === index ? mode.refused.message : open ? undefined : mode.problems.get(index);
  const alone = !savesAsList(editor.draft) && step.kind === "command" ? { then: editor.draft.then, agent: ownName, onThen: (then: Then) => editor.set({ then }) } : null;
  return (
    <>
      <StepCard
        {...head}
        note={stepNote(step, index, alone?.then === "agentTurn" ? alone.agent : undefined)}
        state={problem ? "failed" : open ? "open" : landed ? "target" : marked?.state}
        className={cn(grip.held && "scale-[1.015] shadow-xl")}
        onPress={() => editor.setOpen(open ? null : step.id)}
        expanded={open}
        leading={
          steps.length > 1 ? (
            <button {...grip.handle} className={cn("-ml-1.5 grid h-10 w-6 shrink-0 place-items-center rounded-lg text-base-content/65 outline-none hover:text-base-content focus-visible:ring-2 focus-visible:ring-secondary/50", grip.handle.className)}>
              <GripVertical size={16} aria-hidden="true" />
            </button>
          ) : null
        }
        badge={tag}
        aside={
          <>
            {face}
            {/* Not on a phone, where the card's words are the button and the room is theirs. */}
            <button type="button" className="btn btn-ghost btn-square btn-sm text-base-content/65 hover:text-base-content max-sm:hidden" aria-label={open ? `Close step ${index + 1}` : `Edit step ${index + 1}`} onClick={() => editor.setOpen(open ? null : step.id)}>
              {open ? <X size={16} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />}
            </button>
            <StepMenu index={index} grip={grip} full={steps.length >= STEPS_MAX} editor={editor} onRemove={mode.onRemove} />
          </>
        }
      >
        {problem || resets.length > 0 || open ? (
          <div className="space-y-3">
            {problem ? (
              <p role="alert" className="text-sm font-medium text-error">
                {problem}
              </p>
            ) : null}
            <ResetNotes step={step} resets={resets} onForget={editor.forget} />
            {open ? (
              <StepEditor
                steps={steps}
                index={index}
                own={own}
                agents={mode.agents}
                alone={alone}
                titleOf={titleOf}
                onStep={(next) => editor.setStep(index, next)}
                onKind={(kind) => editor.setKind(index, kind)}
                onExit={(exit, go) => editor.setExit(index, exit, go)}
                onDone={() => editor.setOpen(null)}
              />
            ) : null}
          </div>
        ) : null}
      </StepCard>
      {branches()}
    </>
  );
}
