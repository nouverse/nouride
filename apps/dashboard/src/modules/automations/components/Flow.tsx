/**
 * The flow: an automation read top to bottom. How it starts, each step as a card joined to the next by a line, and
 * where it reports at the end. A step's own paths are chips under its card, and one that jumps past the next step is
 * also a curved line at the side, to the card it lands on.
 *
 * One component for every way the page shows an automation (`FlowMode`): while it is edited the cards can be dragged
 * into another order, a "+" on each line adds a step there and a card opens to its fields; over a run each card says
 * how it went and the path the run took is drawn in the colour of what is done; a suggested change is only read.
 */

import { useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { FLOW_SIDE, FlowLinks, type FlowLink } from "@/commons/components/ui/FlowLinks";
import { PopoverSheet } from "@/commons/components/ui/PopoverSheet";
import { ReorderList } from "@/commons/components/ui/ReorderList";
import { cn } from "@/commons/lib/utils";
import { pathTaken } from "../lib/runs";
import { STEPS_MAX, branchesOf, type Step } from "../lib/steps";
import type { Mark } from "../lib/suggested";
import { stepTitle } from "../lib/words";
import { exitAnchor, jumpKey, stepAnchor } from "./Branches";
import { Connector, StepPicker } from "./Connector";
import { StepItem, type FlowMode } from "./StepItem";

export function Flow({
  steps,
  own,
  agentName,
  mode,
  marks,
  head,
  foot,
}: {
  steps: readonly Step[];
  /** The automation's own agent: who does a step that names no other. */
  own: string;
  agentName: (id: string) => string;
  mode: FlowMode;
  /** What a suggested change would do to each step, by the step's id. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** How it starts, over the first step. */
  head: ReactNode;
  /** Who runs it and where it reports, under the last. */
  foot: ReactNode;
}) {
  const flow = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<number | null>(null);
  const [held, setHeld] = useState(false);

  const titleOf = (step: Step) => stepTitle(step, agentName(("agentId" in step && step.agentId) || own));
  const editing = mode.kind === "edit";
  const legs = mode.kind === "run" ? pathTaken(steps, mode.run) : [];
  const went = (from: number, to: number | "end") => legs.some((leg) => leg.from === from && leg.to === to);

  const links: FlowLink[] = steps.flatMap((step, index) =>
    branchesOf(steps, index)
      .filter((branch) => branch.jump)
      .map((branch) => ({ key: jumpKey(step.id, branch.exit), from: exitAnchor(step.id, branch.exit), to: stepAnchor(steps[branch.to as number]!.id), taken: legs.some((leg) => leg.from === index && leg.exit === branch.exit) })),
  );
  const landsOn = links.find((link) => link.key === active)?.to ?? null;

  const full = steps.length >= STEPS_MAX;
  const add = editing && !full ? (at: number) => (button: HTMLButtonElement) => {
    anchor.current = button;
    setAddAt(at);
  } : null;
  const show = (to: number) => flow.current?.querySelector(`[data-flow-anchor="${stepAnchor(steps[to]!.id)}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  // Everything a card's place depends on that the flow's own size does not show: the order, and what is open.
  const version = `${mode.kind} ${steps.map((step) => step.id).join(" ")} ${editing ? mode.editor.open : ""}`;

  return (
    <div ref={flow} data-flow={mode.kind} className={cn("relative", links.length > 0 && FLOW_SIDE)}>
      {head}

      {steps.length === 0 && editing ? (
        <>
          <Connector short />
          <button
            type="button"
            className="flex w-full flex-col items-center gap-2 rounded-[22px] border-2 border-dashed border-base-content/15 px-4 py-8 text-center transition-colors hover:border-secondary/40 hover:bg-secondary/[0.04]"
            onClick={(event) => {
              anchor.current = event.currentTarget;
              setAddAt(0);
            }}
          >
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-secondary/10 text-secondary">
              <Plus size={18} strokeWidth={2.5} />
            </span>
            <span className="font-display text-lg font-medium text-base-content">Add the first step</span>
            <span className="max-w-sm text-sm text-base-content/65">What should happen when it starts: ask an agent, run a command, send a message, start a mission, or wait for your OK.</span>
          </button>
        </>
      ) : null}

      <ReorderList items={steps} keyOf={(step) => step.id} onMove={(from, to) => (editing ? mode.editor.move(from, to) : undefined)} nameOf={(_step, index) => `step ${index + 1}`} label="Steps" disabled={!editing} onHeld={setHeld}>
        {(_step, index, grip) => (
          <>
            {/* The line into a step: the run went along it when it came here from the step before, or began here. */}
            <Connector
              taken={mode.kind === "run" && (index === 0 ? mode.outcomes.has(steps[0]!.id) : went(index - 1, index))}
              {...(add ? { onAdd: add(index), addLabel: index === 0 ? "Add a step at the start" : `Add a step before step ${index + 1}` } : {})}
            />
            <StepItem steps={steps} index={index} own={own} ownName={agentName(own)} mode={mode} grip={grip} mark={marks?.get(steps[index]!.id)} landed={landsOn === stepAnchor(steps[index]!.id)} active={active} onActive={setActive} onShow={show} titleOf={titleOf} />
          </>
        )}
      </ReorderList>

      {steps.length > 0 || !editing ? <Connector taken={mode.kind === "run" && mode.run.status === "success"} {...(add && steps.length > 0 ? { onAdd: add(steps.length), addLabel: "Add a step at the end" } : {})} /> : <Connector short />}
      {editing && full ? <p className="-mt-1 mb-2 text-center text-xs text-base-content/65">An automation runs at most {STEPS_MAX} steps.</p> : null}
      {foot}

      {/* Out of sight while a card is held: the lines are measured from where the cards belong, not where one is dragged. */}
      <FlowLinks links={links} active={active} version={version} className={cn("transition-opacity duration-150", held && "opacity-0")} />

      {editing ? (
        <PopoverSheet open={addAt !== null} onClose={() => setAddAt(null)} anchor={anchor} label="Add a step" width={340}>
          <StepPicker
            onPick={(kind) => {
              if (addAt !== null) mode.editor.add(addAt, kind);
              setAddAt(null);
            }}
          />
        </PopoverSheet>
      ) : null}
    </div>
  );
}
