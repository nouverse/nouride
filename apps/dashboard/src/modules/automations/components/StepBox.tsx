/**
 * A box of the canvas: an icon tile, a title and one line. The box is what is pressed; nothing else is drawn on it at
 * rest. A step's own rule ("If it fails, it asks you…") is a strip under its words, in the same box, and what opens in
 * place on a phone (its fields) or shows over a run (how it went) is under that.
 *
 * The card it replaces carried everything at once: a handle, "Step 1 ·", a line that explained its kind, the agent's
 * face, a pencil and a menu. Four of them read as a form, not as what an automation does.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export type BoxLook = "open" | "target" | "done" | "failed" | "needs" | "working" | "suggested" | "leaving" | "lacking";

const STATES: Record<BoxLook, string> = {
  open: "border-primary/50 ring-2 ring-primary/25",
  target: "border-secondary/50 ring-2 ring-secondary/30",
  done: "border-success/40",
  failed: "border-error/40",
  lacking: "border-error/50 ring-2 ring-error/15",
  needs: "border-accent/50 ring-2 ring-accent/20",
  working: "border-success/50 ring-2 ring-success/20",
  // A step that is not there yet, or will not be: a dashed edge, as a thing drawn in pencil.
  suggested: "border-2 border-dashed border-accent/50 bg-accent/[0.04] shadow-none",
  leaving: "border-2 border-dashed border-base-content/20 bg-base-200/40 shadow-none",
};

export function StepBox({
  title,
  line,
  mono = false,
  icon: Icon,
  tile,
  state,
  dimmed = false,
  side = false,
  pill = false,
  onPress,
  pressLabel,
  expanded,
  badge,
  hover,
  strip,
  children,
  className,
  anchor,
}: {
  title: string;
  /** What it does, cut at one line. */
  line?: string | undefined;
  /** The line is something typed as it is (a command), drawn in the mono face. */
  mono?: boolean;
  icon: LucideIcon;
  /** The tile's colours, behind the icon. */
  tile: string;
  state?: BoxLook | undefined;
  /** Not part of what is being looked at: a step a run never reached. */
  dimmed?: boolean;
  /** A step of a lane: drawn in pencil, off the main line. */
  side?: boolean;
  /** The canvas's first and last box: how it starts, where its results go. */
  pill?: boolean;
  /** A press on the box; none makes it words and nothing more. */
  onPress?: (() => void) | undefined;
  pressLabel?: string | undefined;
  expanded?: boolean | undefined;
  /** Beside its title: a word about this box, as a small tag. */
  badge?: ReactNode;
  /** What shows when the pointer or the focus is on the box: a handle to drag it by, its menu. */
  hover?: ReactNode;
  /** Its own rules, under its words. */
  strip?: ReactNode;
  /** Under that, inside the box: its fields in place, or how it went. */
  children?: ReactNode;
  className?: string;
  /** Its name for a line drawn to it (`FlowLinks`), and what a test finds it by. */
  anchor?: string;
}) {
  const words = (
    <>
      <span aria-hidden="true" className={cn("grid size-9 shrink-0 place-items-center rounded-[11px]", tile, dimmed && "opacity-50 grayscale")}>
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span data-box-title className="min-w-0 text-[15px] leading-snug font-semibold text-base-content [overflow-wrap:anywhere]">
            {title}
          </span>
          {badge}
        </span>
        {line ? <span className={cn("block truncate text-[13px] leading-snug text-base-content/65", mono && "font-mono text-xs")}>{line}</span> : null}
      </span>
    </>
  );
  return (
    <div
      data-flow-anchor={anchor}
      data-state={state}
      data-dimmed={dimmed ? "" : undefined}
      data-side={side ? "" : undefined}
      className={cn(
        "group/box relative overflow-hidden border border-base-content/[0.08] bg-base-100 shadow-soft transition-[border-color,box-shadow,opacity] duration-200",
        pill ? "rounded-[28px]" : "rounded-[18px]",
        side && "border-dashed border-secondary/35 shadow-none",
        state && STATES[state],
        // Set back, not faded: its words are still read, so they keep their ink. Flat on the canvas, its tile greyed.
        dimmed && "border-dashed border-base-content/15 bg-transparent shadow-none",
        className,
      )}
    >
      {/* At work: its ring breathes, in opacity alone, which the reduced-motion rule holds still. */}
      {state === "working" ? <span aria-hidden="true" data-working="" className="pointer-events-none absolute -inset-px animate-pulse rounded-[inherit] ring-2 ring-success/40" /> : null}
      <div className="flex items-center gap-1">
        {onPress ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={pressLabel}
            onClick={onPress}
            className={cn("flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left outline-none focus-visible:bg-base-content/[0.04]", pill && "px-3")}
          >
            {words}
          </button>
        ) : (
          <div className={cn("flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3.5 py-3", pill && "px-3")}>{words}</div>
        )}
        {/* Over the box's end, taking no room of its words: they showed two lines where one fits. */}
        {hover ? (
          <div className="absolute top-3.5 right-2 flex items-center gap-0.5 rounded-xl bg-base-100 opacity-0 shadow-soft transition-opacity duration-150 group-focus-within/box:opacity-100 group-hover/box:opacity-100 max-md:hidden">{hover}</div>
        ) : null}
      </div>
      {strip}
      {children ? <div className="border-t border-base-content/[0.08] p-3.5">{children}</div> : null}
    </div>
  );
}
