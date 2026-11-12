/**
 * A step of an automation that waits for a person: the question it asks, what the step before it said to decide on,
 * and the two answers. One piece for an automation's own page, where it is drawn in the step's card, and for Waiting
 * for you and Home, where it is a card of its own (`WaitingStepCard`).
 *
 * The answers are an operator's or an admin's, as every change is: an account that can only look is shown the question
 * and no buttons, where a press would be refused. So is whoever only reads the automation, on its own page: it is
 * another person's to answer, and the line says whose.
 */

import { Check, X } from "lucide-react";
import { useAnswerStep } from "@/commons/hooks/use-waiting-steps";
import { inTime } from "@/commons/lib/format";

/** The question, what came before it, and Continue and Stop. */
export function StepQuestion({
  runId,
  name,
  ask,
  said,
  until,
  canAnswer,
  whom,
}: {
  runId: string;
  /** The automation's name, for what the answer's toast says. */
  name: string;
  /** The question. Left out where what it is drawn in already says it: the step's own card. */
  ask?: string | undefined;
  said?: string | undefined;
  /** When it stops waiting. */
  until?: number | undefined;
  canAnswer: boolean;
  /** Who answers it, where the reader only reads the automation: a person's name, or "an admin". */
  whom?: string | undefined;
}) {
  const answer = useAnswerStep();
  return (
    <div className="space-y-3">
      {ask ? <p className="font-display text-lg leading-snug font-medium text-base-content [overflow-wrap:anywhere]">{ask}</p> : null}
      {said ? (
        <details className="rounded-[14px] bg-base-200/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none text-xs font-semibold text-base-content/70">What the step before said</summary>
          <p className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap text-base-content/85 [overflow-wrap:anywhere]">{said}</p>
        </details>
      ) : null}
      {canAnswer ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm gap-1.5 max-sm:flex-1" disabled={answer.isPending} onClick={() => answer.mutate({ runId, go: true, name })}>
            <Check size={14} aria-hidden="true" /> Continue
          </button>
          <button type="button" className="btn btn-ghost btn-sm gap-1.5 border border-base-content/10 max-sm:flex-1" disabled={answer.isPending} onClick={() => answer.mutate({ runId, go: false, name })}>
            <X size={14} aria-hidden="true" /> Stop
          </button>
          {until ? <span className="text-xs text-base-content/65">Waits {inTime(until).replace(/^in /, "")} more, then stops.</span> : null}
        </div>
      ) : (
        <p className="text-xs text-base-content/65">{whom ? `${whom.charAt(0).toUpperCase()}${whom.slice(1)} can answer this.` : "Someone who may change automations can answer this."}</p>
      )}
    </div>
  );
}
