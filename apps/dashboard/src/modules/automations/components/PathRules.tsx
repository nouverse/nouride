/**
 * A step's own rules as its box says them, and the marks a lane ends in (`lib/paths.ts`).
 *
 * The strip is one sentence a rule: "If it fails, the run goes on anyway", or the question it asks with both answers
 * and where each leads. The lane that led to "Ask me first" had one end drawn, and "then the run ends" under it did not
 * say after which answer: so each answer's end is on the strip itself.
 *
 * A lane's end is a mark and never words alone: a line back with the step it rejoins named, or a stop.
 */

import { CornerDownLeft, Square } from "lucide-react";
import { cn } from "@/commons/lib/utils";
import type { Rule } from "../lib/paths";
import type { Step } from "../lib/steps";
import { GOES_ON, exitChip } from "../lib/words";

/** One rule in a box: its path's name, then what the run does. `taken`: over a run, the run left this step by it. */
export function RuleStrip({ step, rule, question, taken = false, lacking = false }: { step: Step; rule: Extract<Rule, { kind: "goOn" | "ask" }>; question?: string | undefined; taken?: boolean; lacking?: boolean }) {
  const name = exitChip(step, rule.exit);
  return (
    <div data-rule={rule.exit} data-rule-kind={rule.kind} data-taken={taken ? "" : undefined} className={cn("border-t border-dashed px-3.5 py-2.5 text-[13px] leading-snug text-base-content/80", taken ? "border-success/40 bg-success/[0.07]" : "border-secondary/30 bg-secondary/[0.06]")}>
      {rule.kind === "goOn" ? (
        <p>
          <b className="font-bold text-secondary">{name},</b> {GOES_ON}
        </p>
      ) : (
        <>
          <p>
            <b className="font-bold text-secondary">{name},</b> it asks you:
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

/** Something else a box says of its own step, where its rules are: a sentence, in plain ink. */
export function FactStrip({ children }: { children: string }) {
  return (
    <p data-fact className="border-t border-dashed border-base-content/15 px-3.5 py-2 text-[13px] leading-snug text-base-content/75">
      {children}
    </p>
  );
}

/** Where a lane ends: back into the main line at a step, named, or a stop. */
export function LaneEnd({ ends, title }: { ends: "stop" | "back"; title?: string | undefined }) {
  return ends === "back" ? (
    <p data-lane-end="back" className="mt-2 flex items-center gap-1.5 pl-1 text-xs font-bold text-success">
      <CornerDownLeft size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">Then back to “{title}”</span>
    </p>
  ) : (
    <p data-lane-end="stop" className="mt-2 flex items-center gap-1.5 pl-1 text-xs font-bold text-base-content/75">
      <Square size={10} aria-hidden="true" className="shrink-0 fill-secondary text-secondary" />
      The run stops here
    </p>
  );
}

/** The short line from a lane's step to the next one under it. */
export function LaneLine({ taken = false }: { taken?: boolean }) {
  return <div aria-hidden="true" data-lane-line data-taken={taken ? "" : undefined} className={cn("mx-auto h-4 w-0.5 rounded-full", taken ? "bg-success" : "bg-secondary/30")} />;
}
