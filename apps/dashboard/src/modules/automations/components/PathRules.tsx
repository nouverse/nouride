/**
 * A step's own rules as its box says them, and the marks a lane ends in (`lib/paths.ts`).
 *
 * The strip is one sentence a rule: "If it fails, the run goes on anyway", or the question it asks with both answers
 * and where each leads. The lane that led to "Ask me first" had one end drawn, and "then the run ends" under it did not
 * say after which answer: so each answer's end is on the strip itself.
 *
 * A path left at a stop is said too, in plain ink with a stop's mark: every box that can fail says what a failure does,
 * so the answer chosen in its fields is always seen on the canvas. Each strip opens with its answer's mark: a stop, an
 * arrow on, a hand.
 *
 * A lane's end is a mark and never words alone: a line back with the step it rejoins named by its place, or a stop.
 * While the steps are changed the mark is pressed to set it, to any step the run passes after the one the lane hangs
 * on: it was set only in the fields of that step, where a person who had the lane in front of them did not look, and
 * only to the step right after it.
 */

import { ArrowDown, ChevronDown, CornerDownLeft, Hand, Square } from "lucide-react";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { cn } from "@/commons/lib/utils";
import { laneBacks, type PathExit, type Paths, type Rule } from "../lib/paths";
import type { Step } from "../lib/steps";
import { GOES_ON, exitChip, placeTitle, stopsWords } from "../lib/words";

const MARK = "mt-[3px] shrink-0";

/** One rule in a box: its path's name, then what the run does. `taken`: over a run, the run left this step by it. */
export function RuleStrip({ step, rule, question, taken = false, lacking = false }: { step: Step; rule: Extract<Rule, { kind: "goOn" | "ask" }>; question?: string | undefined; taken?: boolean; lacking?: boolean }) {
  const name = exitChip(step, rule.exit);
  return (
    <div data-rule={rule.exit} data-rule-kind={rule.kind} data-taken={taken ? "" : undefined} className={cn("border-t border-dashed px-3.5 py-2.5 text-[13px] leading-snug text-base-content/80", taken ? "border-success/40 bg-success/[0.07]" : "border-secondary/30 bg-secondary/[0.06]")}>
      {rule.kind === "goOn" ? (
        <p className="flex items-start gap-2">
          <ArrowDown size={13} strokeWidth={2.5} aria-hidden="true" className={cn(MARK, "text-secondary")} />
          <span>
            <b className="font-bold text-secondary">{name},</b> {GOES_ON}
          </span>
        </p>
      ) : (
        <>
          <p className="flex items-start gap-2">
            <Hand size={13} strokeWidth={2.5} aria-hidden="true" className={cn(MARK, "text-secondary")} />
            <span>
              <b className="font-bold text-secondary">{name},</b> it asks you:
            </span>
          </p>
          <p className={cn("mt-0.5 font-semibold [overflow-wrap:anywhere]", lacking ? "text-error" : "text-base-content")}>{question?.trim() ? `“${question.trim()}”` : "Write the question to ask."}</p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-bold text-success">
              Yes <span className="font-semibold">goes on</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-base-content/[0.07] px-2.5 py-0.5 text-xs font-bold text-base-content/75">
              No <span className="font-semibold">stops here</span>
            </span>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A path left at a stop, in a box: "If it fails, the run ends, and its chat is told why." Plain ink, since it is what a
 * step does unless told otherwise, with a stop's mark in the colour of a failure. `taken`: over a run, the run ended here.
 */
export function StopStrip({ step, exit, taken = false }: { step: Step; exit: PathExit; taken?: boolean }) {
  // A wait's no ends the run with nothing counted as failed: its mark is plain.
  const failure = step.kind !== "approval";
  return (
    <p data-stops={exit} data-taken={taken ? "" : undefined} className={cn("flex items-start gap-2 border-t border-dashed px-3.5 py-2 text-[13px] leading-snug text-base-content/75", taken && failure ? "border-error/40 bg-error/[0.07]" : "border-base-content/15")}>
      <Square size={10} aria-hidden="true" className={cn("mt-1 shrink-0", failure ? "fill-error/80 text-error/80" : "fill-base-content/45 text-base-content/45")} />
      <span>
        <b className="font-bold text-base-content/90">{exitChip(step, exit)},</b> {stopsWords(step, exit)}
      </span>
    </p>
  );
}

/** Something else a box says of its own step, where its rules are: a sentence, in plain ink. */
export function FactStrip({ children }: { children: string }) {
  return (
    <p data-fact className="border-t border-dashed border-base-content/15 px-3.5 py-2 text-[13px] leading-snug text-base-content/75">
      {children}
    </p>
  );
}

/** A step a lane can go back to, as its end offers it: by its id, and named by its place and title. */
export interface LaneBack {
  id: string;
  name: string;
  chosen: boolean;
}

/** The steps of the main line a lane can go back to, each as its end names it, with the one it goes back to now. */
export function laneBackChoices(steps: readonly Step[], owner: number, rule: Extract<Rule, { kind: "lane" }>, paths: Paths, titleOf: (step: Step) => string): LaneBack[] {
  const now = rule.ends === "stop" ? null : rule.ends.back;
  return laneBacks(steps, owner, rule.lane).map((at) => ({ id: steps[at]!.id, name: placeTitle(paths.line.indexOf(at), titleOf(steps[at]!)), chosen: at === now }));
}

const END_ITEM = "min-h-10 items-start gap-2.5 rounded-xl py-2 text-left text-sm leading-snug";
const STOPS = "The run stops here";

/**
 * Where a lane ends: back into the main line at a step, named, or a stop. `onSet`: the mark is pressed to choose
 * among every step the lane can go back to and a stop, where the steps are being changed. `onActive`: the pointer or
 * the focus is on it, which lights its way back and the step that lands on.
 */
export function LaneEnd({
  anchor,
  backs,
  onSet,
  onActive,
}: {
  /** Its name for the thread drawn from it (`FlowLinks`). */
  anchor: string;
  /** The steps it can go back to, the one it goes back to now marked; none marked is a stop. */
  backs: readonly LaneBack[];
  onSet?: ((ends: "stop" | { to: string }) => void) | undefined;
  onActive?: ((on: boolean) => void) | undefined;
}) {
  const now = backs.find((back) => back.chosen);
  const ends = now ? "back" : "stop";
  const words = now ? `Then back to ${now.name}` : STOPS;
  const mark = now ? <CornerDownLeft size={13} aria-hidden="true" className="shrink-0" /> : <Square size={10} aria-hidden="true" className="shrink-0 fill-secondary text-secondary" />;
  const ink = now ? "text-success" : "text-base-content/75";
  const hover = onActive ? { onMouseEnter: () => onActive(true), onMouseLeave: () => onActive(false), onFocus: () => onActive(true), onBlur: () => onActive(false) } : {};
  if (!onSet || backs.length === 0) {
    return (
      <p data-lane-end={ends} data-flow-anchor={anchor} className={cn("mt-2 flex items-center gap-1.5 pl-1 text-xs font-bold", ink)} {...hover}>
        {mark}
        <span className="min-w-0 [overflow-wrap:anywhere]">{words}</span>
      </p>
    );
  }
  return (
    // As wide as its words, so the thread drawn from it leaves from where they begin.
    <div data-lane-end={ends} data-flow-anchor={anchor} className="mt-1.5 w-fit max-w-full" {...hover}>
      <DropdownMenu
        trigger={
          <>
            {mark}
            <span className="min-w-0 [overflow-wrap:anywhere]">{words}</span>
            <ChevronDown size={13} aria-hidden="true" className="shrink-0 opacity-70" />
          </>
        }
        triggerClassName={cn("inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-transparent px-2 py-1 text-left text-xs font-bold outline-none transition-colors hover:border-base-content/15 hover:bg-base-100 focus-visible:ring-2 focus-visible:ring-secondary/50", ink)}
        ariaLabel={`After these steps: ${words}. Change it`}
        width={288}
        align="start"
        menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
      >
        {(close) => (
          <>
            {backs.map((back) => (
              <li key={back.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={back.chosen}
                  className={cn(END_ITEM, back.chosen && "font-bold text-secondary")}
                  onClick={() => {
                    close();
                    if (!back.chosen) onSet({ to: back.id });
                  }}
                >
                  <CornerDownLeft size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">Back to {back.name}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!now}
                className={cn(END_ITEM, !now && "font-bold text-secondary")}
                onClick={() => {
                  close();
                  if (now) onSet("stop");
                }}
              >
                <Square size={10} aria-hidden="true" className="mt-1.5 shrink-0 fill-current" />
                <span className="min-w-0">{STOPS}</span>
              </button>
            </li>
          </>
        )}
      </DropdownMenu>
    </div>
  );
}

/** The same choice as a field of a step's fields: every step the lane can go back to, and a stop. */
export function LaneEndPick({ backs, onSet }: { backs: readonly LaneBack[]; onSet: (ends: "stop" | { to: string }) => void }) {
  if (backs.length === 0) return <p className="text-sm text-base-content/85">The run stops: nothing follows the step they run for.</p>;
  return (
    <SearchSelect
      label="After these steps"
      align="start"
      className="w-full bg-base-100"
      width={320}
      options={[...backs.map((back) => ({ value: back.id, label: `Go back to ${back.name}` })), { value: "", label: "Stop" }]}
      value={backs.find((back) => back.chosen)?.id ?? ""}
      onChange={(next) => onSet(next ? { to: next } : "stop")}
    />
  );
}

/** The short line from a lane's step to the next one under it. */
export function LaneLine({ taken = false }: { taken?: boolean }) {
  return <div aria-hidden="true" data-lane-line data-taken={taken ? "" : undefined} className={cn("mx-auto h-4 w-0.5 rounded-full", taken ? "bg-success" : "bg-secondary/30")} />;
}
