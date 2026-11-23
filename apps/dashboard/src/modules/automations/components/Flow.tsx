/**
 * The canvas: an automation read top to bottom on a quiet dotted ground. How it starts, each step as a compact box
 * joined to the next by a line, and where its results go at the end. A step's own rule is a strip in its box, and steps
 * that run in its place hang in a lane at its side, under it where there is no room beside (`lib/paths.ts`).
 *
 * One component for every way the page shows an automation (`FlowMode`): while it is edited a box is pressed to open its
 * fields, dragged into another order by the handle that shows on it, and a step is added at the end or on a line; over a
 * run each box says how it went and the path the run took is drawn in the colour of what is done; a suggested change is
 * only read.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { FLOW_SIDE, FlowLinks, type FlowLink } from "@/commons/components/ui/FlowLinks";
import { PopoverSheet } from "@/commons/components/ui/PopoverSheet";
import { ReorderList } from "@/commons/components/ui/ReorderList";
import { cn } from "@/commons/lib/utils";
import { chipExits, pathsOf, type PathExit } from "../lib/paths";
import { pathTaken } from "../lib/runs";
import { STEPS_MAX, landsAt, type Step } from "../lib/steps";
import type { Mark } from "../lib/suggested";
import { stepTitle } from "../lib/words";
import { exitAnchor, jumpKey, stepAnchor } from "./Branches";
import { Connector, StepPicker } from "./Connector";
import { LANED_ROW, PLAIN_ROW, StepItem, type FlowMode, type Inline } from "./StepItem";

/** Where a step picked from the "+" goes: on the main line before a step (or at its end), or at the end of a lane. */
type AddAt = { before: number | null } | { owner: number; exit: PathExit };

export function Flow({
  steps,
  own,
  agentName,
  reads,
  mode,
  marks,
  head,
  foot,
  inline,
}: {
  steps: readonly Step[];
  /** The automation's own agent: who does a step that names no other. */
  own: string;
  agentName: (id: string) => string;
  /** The agent a lone command hands what it printed to, where the automation is that and no list. */
  reads?: string | undefined;
  mode: FlowMode;
  /** What a suggested change would do to each step, by the step's id. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** How it starts, over the first step. */
  head: ReactNode;
  /** Where its results go, under the last. */
  foot: ReactNode;
  /** A step's fields opened in its own box, where there is no room for them beside the canvas. */
  inline: Inline | null;
}) {
  const flow = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<AddAt | null>(null);
  const [held, setHeld] = useState(false);

  // Over a run a wait a path leads to is a step that went some way: a box of its own, in a lane of one.
  const paths = useMemo(() => pathsOf(steps, mode.kind !== "run"), [steps, mode.kind]);
  const line = paths.line;
  const wide = [...paths.rules.values()].some((rules) => rules.some((rule) => rule.kind === "lane"));
  const row = wide ? LANED_ROW : PLAIN_ROW;

  const titleOf = (step: Step) => stepTitle(step, agentName(("agentId" in step && step.agentId) || own));
  const editing = mode.kind === "edit";
  const legs = mode.kind === "run" ? pathTaken(steps, mode.run) : [];
  /** The run came to this step: along the line from the step above, or back from a lane. */
  const reached = (to: number) => (mode.kind === "run" ? (to === line[0] ? mode.outcomes.has(steps[to]!.id) : legs.some((leg) => leg.to === to)) : false);

  // A path the canvas does not draw, to a step that is there: a line at the side, from its chip to the box it lands on.
  const links: FlowLink[] = steps.flatMap((step, index) =>
    chipExits(steps, index, paths).flatMap((exit): FlowLink[] => {
      const to = landsAt(steps, index, exit);
      return to === "end" ? [] : [{ key: jumpKey(step.id, exit), from: exitAnchor(step.id, exit), to: stepAnchor(steps[to]!.id), taken: legs.some((leg) => leg.from === index && leg.exit === exit) }];
    }),
  );
  const landsOn = links.find((link) => link.key === active)?.to ?? null;

  const full = steps.length >= STEPS_MAX;
  const picker = (at: AddAt) => (button: HTMLButtonElement) => {
    anchor.current = button;
    setAddAt(at);
  };
  const add = editing && !full ? (before: number | null) => picker({ before }) : null;
  const show = (to: number) => flow.current?.querySelector(`[data-flow-anchor="${stepAnchor(steps[to]!.id)}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  // Everything a box's place depends on that the canvas's own size does not show: the order, and what is open in it.
  const version = `${mode.kind} ${steps.map((step) => step.id).join(" ")} ${inline?.key ?? ""}`;
  const lined = (node: ReactNode) => (
    <div className={row}>
      <div className="min-w-0">{node}</div>
    </div>
  );

  return (
    <div ref={flow} data-flow={mode.kind} className={cn("@container/flow relative rounded-[22px] border border-base-content/[0.08] bg-[radial-gradient(color-mix(in_oklab,var(--color-base-content)_9%,transparent)_1px,transparent_1px)] bg-[length:18px_18px] px-3 py-6 sm:px-6 sm:py-7", links.length > 0 && FLOW_SIDE)}>
      {lined(head)}

      {steps.length === 0 && editing ? (
        <>
          {lined(<Connector short />)}
          {lined(
            <button
              type="button"
              className="flex min-h-16 w-full items-center justify-center gap-2 rounded-[18px] border-2 border-dashed border-base-content/20 bg-base-100/60 px-4 text-[15px] font-semibold text-base-content/80 transition-colors hover:border-secondary/40 hover:bg-secondary/[0.04] hover:text-secondary"
              onClick={(event) => picker({ before: null })(event.currentTarget)}
            >
              <Plus size={17} strokeWidth={2.5} aria-hidden="true" /> Add the first step
            </button>,
          )}
          {lined(<Connector short />)}
        </>
      ) : null}

      <ReorderList items={line.map((at) => steps[at]!)} keyOf={(step) => step.id} onMove={(from, to) => (editing ? mode.editor.move(from, to) : undefined)} nameOf={(_step, place) => `step ${place + 1}`} label="Steps" disabled={!editing} onHeld={setHeld}>
        {(_step, place, grip) => (
          <>
            {/* The line into a step: the run went along it when it came here. */}
            {lined(<Connector taken={reached(line[place]!)} {...(add ? { onAdd: add(line[place]!), addLabel: place === 0 ? "Add a step at the start" : `Add a step before step ${place + 1}` } : {})} />)}
            <StepItem
              steps={steps}
              index={line[place]!}
              place={place}
              paths={paths}
              ownName={agentName(own)}
              reads={reads}
              agentName={agentName}
              mode={mode}
              grip={grip}
              marks={marks}
              landsOn={landsOn}
              active={active}
              onActive={setActive}
              onShow={show}
              titleOf={titleOf}
              inline={inline}
              wide={wide}
              onLaneAdd={editing && !full ? (owner, exit) => picker({ owner, exit }) : undefined}
            />
          </>
        )}
      </ReorderList>

      {steps.length > 0 ? (
        <>
          {lined(<Connector short taken={mode.kind === "run" && mode.run.status === "success"} />)}
          {add
            ? lined(
                <div className="flex justify-center">
                  <button
                    type="button"
                    aria-label="Add a step at the end"
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-base-content/25 bg-base-100 px-4 text-sm font-bold text-base-content/80 transition-colors hover:border-secondary/40 hover:text-secondary"
                    onClick={(event) => add(null)(event.currentTarget)}
                  >
                    <Plus size={15} strokeWidth={2.5} aria-hidden="true" /> Add a step
                  </button>
                </div>,
              )
            : null}
          {add ? lined(<Connector short taken={mode.kind === "run" && mode.run.status === "success"} />) : null}
        </>
      ) : null}
      {editing && full ? <p className="mb-2 text-center text-xs text-base-content/65">An automation runs at most {STEPS_MAX} steps.</p> : null}
      {lined(foot)}
      {editing ? <p className="mt-4 text-center text-[13px] text-base-content/65">Press a box to change it.</p> : null}

      {/* Out of sight while a box is held: the lines are measured from where the boxes belong, not where one is dragged. */}
      <FlowLinks links={links} active={active} version={version} className={cn("transition-opacity duration-150", held && "opacity-0")} />

      {editing ? (
        <PopoverSheet open={addAt !== null} onClose={() => setAddAt(null)} anchor={anchor} label="Add a step" width={340} align="center">
          <StepPicker
            onPick={(kind) => {
              if (addAt && "owner" in addAt) mode.editor.addToLane(addAt.owner, addAt.exit, kind);
              else if (addAt) mode.editor.add(addAt.before, kind);
              setAddAt(null);
            }}
          />
        </PopoverSheet>
      ) : null}
    </div>
  );
}
