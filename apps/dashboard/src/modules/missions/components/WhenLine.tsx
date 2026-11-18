/**
 * A mission's one time line ("drafted 2 days ago"), with the day and the minute behind it: hovered, or reached with the
 * keyboard, it says when the mission was made, started, has waited since and ended. A phone has nothing to hover, so
 * there the day is written beside the line.
 */

import type { MissionView } from "@nouride/wire";
import { useWide } from "@/commons/hooks/use-wide";
import { cn } from "@/commons/lib/utils";
import { dayBeside, timeLine, whenTip } from "../lib/board";

export function WhenLine({ mission, className }: { mission: MissionView; className?: string }) {
  const wide = useWide();
  const tip = whenTip(mission);
  if (!wide) {
    return (
      <span className={cn("block font-mono text-[11px] text-base-content/65", className)} data-time>
        {timeLine(mission)} · {dayBeside(mission)}
      </span>
    );
  }
  return (
    <span className={cn("tooltip tooltip-bottom block", className)} data-tip={tip}>
      <span tabIndex={0} className="cursor-default rounded font-mono text-[11px] text-base-content/65 underline decoration-base-content/25 decoration-dotted underline-offset-4" data-time>
        {timeLine(mission)}
      </span>
      {/* A tooltip is drawn by CSS from `data-tip`, which a screen reader does not read. */}
      <span className="sr-only">: {tip}</span>
    </span>
  );
}
