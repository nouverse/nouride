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
 * While the steps are changed the mark is pressed to set it: it was set only in the fields of the step the lane hangs
 * on, where a person who had the lane in front of them did not look.
 */

import { ArrowDown, ChevronDown, CornerDownLeft, Hand, Square } from "lucide-react";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { cn } from "@/commons/lib/utils";
import type { PathExit, Rule } from "../lib/paths";
import type { Step } from "../lib/steps";
import { GOES_ON, exitChip, stopsWords } from "../lib/words";

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

/** A lane's two ends, as its mark and its fields offer them. `back`: the step the main line goes on with, named. */
const laneEndWords = (back: string): Record<"back" | "stop", string> => ({ back: `Then back to ${back}`, stop: "The run stops here" });

const END_ITEM = "min-h-10 items-start gap-2.5 rounded-xl py-2 text-left text-sm leading-snug";

/**
 * Where a lane ends: back into the main line at a step, named, or a stop. `onSet`: the mark is pressed to choose
 * between the two, where the steps are being changed and the main line goes on to a step at all.
 */
export function LaneEnd({ ends, back, onSet }: { ends: "stop" | "back"; /** The step the main line goes on with, as it is named: `step 4, “Tell me”`. */ back?: string | undefined; onSet?: ((ends: "stop" | "back") => void) | undefined }) {
  const words = laneEndWords(back ?? "");
  const mark = ends === "back" ? <CornerDownLeft size={13} aria-hidden="true" className="shrink-0" /> : <Square size={10} aria-hidden="true" className="shrink-0 fill-secondary text-secondary" />;
  const ink = ends === "back" ? "text-success" : "text-base-content/75";
  if (!onSet || !back) {
    return (
      <p data-lane-end={ends} className={cn("mt-2 flex items-center gap-1.5 pl-1 text-xs font-bold", ink)}>
        {mark}
        <span className="min-w-0 [overflow-wrap:anywhere]">{words[ends]}</span>
      </p>
    );
  }
  return (
    <div data-lane-end={ends} className="mt-1.5">
      <DropdownMenu
        trigger={
          <>
            {mark}
            <span className="min-w-0 [overflow-wrap:anywhere]">{words[ends]}</span>
            <ChevronDown size={13} aria-hidden="true" className="shrink-0 opacity-70" />
          </>
        }
        triggerClassName={cn("inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-transparent px-2 py-1 text-left text-xs font-bold outline-none transition-colors hover:border-base-content/15 hover:bg-base-100 focus-visible:ring-2 focus-visible:ring-secondary/50", ink)}
        ariaLabel={`After these steps: ${words[ends]}. Change it`}
        width={272}
        align="start"
        menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
      >
        {(close) =>
          (["back", "stop"] as const).map((one) => (
            <li key={one}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={ends === one}
                className={cn(END_ITEM, ends === one && "font-bold text-secondary")}
                onClick={() => {
                  close();
                  if (one !== ends) onSet(one);
                }}
              >
                {one === "back" ? <CornerDownLeft size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : <Square size={10} aria-hidden="true" className="mt-1.5 shrink-0 fill-current" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{words[one]}</span>
              </button>
            </li>
          ))
        }
      </DropdownMenu>
    </div>
  );
}

/** The short line from a lane's step to the next one under it. */
export function LaneLine({ taken = false }: { taken?: boolean }) {
  return <div aria-hidden="true" data-lane-line data-taken={taken ? "" : undefined} className={cn("mx-auto h-4 w-0.5 rounded-full", taken ? "bg-success" : "bg-secondary/30")} />;
}
