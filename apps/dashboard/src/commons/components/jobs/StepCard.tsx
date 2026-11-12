/**
 * One step of a flow as a card: a tile with its icon in its kind's soft colour, what it is called, and one line of what
 * it does. The card is the shape only. What a press on it does, what stands at its sides and what opens under it are
 * its caller's: an automation's editor opens the step's fields in it, a run draws how the step went.
 *
 * A floating card as every other (22px corners, a hairline, the soft shadow), with a ring in the colour of what its
 * `state` says: where you are while it is open, what is done or failed over a run, what needs you, what a jump under
 * the pointer lands on.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export type StepCardState = "open" | "target" | "done" | "failed" | "needs" | "working" | "suggested" | "leaving";

const STATES: Record<StepCardState, string> = {
  open: "border-secondary/40 ring-2 ring-secondary/20",
  target: "border-secondary/50 ring-2 ring-secondary/30",
  done: "border-success/40",
  failed: "border-error/40",
  needs: "border-accent/50 ring-2 ring-accent/20",
  working: "border-success/50 ring-2 ring-success/20",
  // A step that is not there yet, or will not be: a dashed edge, as a thing drawn in pencil.
  suggested: "border-2 border-dashed border-accent/50 bg-accent/[0.04] shadow-none",
  leaving: "border-2 border-dashed border-base-content/20 bg-base-200/40 shadow-none",
};

export function StepCard({
  eyebrow,
  title,
  line,
  mono = false,
  note,
  whole = false,
  icon: Icon,
  tile,
  state,
  dimmed = false,
  onPress,
  pressLabel,
  expanded,
  badge,
  leading,
  aside,
  children,
  className,
  anchor,
}: {
  /** The small line over the title: "Step 2". */
  eyebrow: string;
  title: string;
  /** What it does, in a line or two. */
  line?: string;
  /** The line is something typed as it is (a command), drawn in the mono face. */
  mono?: boolean;
  /** A few quiet words under the line: what this step costs or waits for. */
  note?: string | undefined;
  /** The line is read whole, however long: a question that waits for an answer. Otherwise it is cut at two lines. */
  whole?: boolean;
  icon: LucideIcon;
  /** The tile's colours, behind the icon. */
  tile: string;
  state?: StepCardState | undefined;
  /** Not part of what is being looked at: a step a run never reached. */
  dimmed?: boolean;
  /** A press on the card's words; none makes them words and nothing more. */
  onPress?: (() => void) | undefined;
  pressLabel?: string | undefined;
  /** Whether what a press opens is open. */
  expanded?: boolean | undefined;
  /** Beside what it is called: a word about this card, as a small tag. */
  badge?: ReactNode;
  /** Before the tile: a handle to drag it by. */
  leading?: ReactNode;
  /** After the words: whose step it is, its buttons. */
  aside?: ReactNode;
  /** Under the head, inside the card: its fields, or how it went. */
  children?: ReactNode;
  className?: string;
  /** Its name for a line drawn to it (`FlowLinks`). */
  anchor?: string;
}) {
  const words = (
    <>
      <span aria-hidden="true" className={cn("grid size-9 shrink-0 place-items-center rounded-[13px] sm:size-10 sm:rounded-[14px]", tile, dimmed && "opacity-50 grayscale")}>
        <Icon size={19} />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-bold text-base-content/65">
            {eyebrow} <span aria-hidden="true">·</span> <span className="text-base-content/85">{title}</span>
          </span>
          {badge}
        </span>
        {/* A line more on a phone, where a line holds half the words. */}
        {line ? <span className={cn("block text-sm text-base-content [overflow-wrap:anywhere]", !whole && "line-clamp-3 sm:line-clamp-2", mono ? "font-mono text-[13px]" : "font-medium")}>{line}</span> : null}
        {note ? <span className="block text-xs text-base-content/65">{note}</span> : null}
      </span>
    </>
  );
  return (
    <div
      data-flow-anchor={anchor}
      data-state={state}
      data-dimmed={dimmed ? "" : undefined}
      className={cn(
        "relative rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft transition-[border-color,box-shadow,opacity] duration-200",
        state && STATES[state],
        // Set back, not faded: its words are still read, so they keep their ink. Flat on the page, its tile greyed.
        dimmed && "border-dashed border-base-content/15 bg-transparent shadow-none",
        className,
      )}
    >
      {/* At work: its ring breathes, in opacity alone, which the reduced-motion rule holds still. */}
      {state === "working" ? <span aria-hidden="true" data-working="" className="pointer-events-none absolute -inset-px animate-pulse rounded-[inherit] ring-2 ring-success/40" /> : null}
      <div className="flex items-start gap-2.5 p-3.5 sm:gap-3 sm:p-4">
        {leading}
        {onPress ? (
          <button type="button" aria-expanded={expanded} aria-label={pressLabel} onClick={onPress} className="flex min-w-0 flex-1 items-start gap-3 rounded-[14px] text-left outline-none focus-visible:ring-2 focus-visible:ring-secondary/50">
            {words}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3">{words}</div>
        )}
        {aside ? <div className="flex shrink-0 items-center gap-1">{aside}</div> : null}
      </div>
      {children ? <div className="border-t border-base-content/[0.08] p-3.5 sm:p-4">{children}</div> : null}
    </div>
  );
}
