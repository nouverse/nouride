/** What a person sees a mission as — working, needs you and with what, done, ended — as a capsule, the same on both pages. */

import type { MissionView } from "@nouride/wire";
import { cn } from "@/commons/lib/utils";
import { seenAs, SEEN_TONE } from "../lib/mission";

export function SeenBadge({ mission, className }: { mission: Pick<MissionView, "seen" | "status" | "waitKind" | "startedAt">; className?: string }) {
  const working = mission.seen === "working" && mission.status === "running";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold whitespace-nowrap",
        SEEN_TONE[mission.seen],
        className,
      )}
    >
      {/* A live dot only where something is happening now: daisyUI's status, with the theme's halo. */}
      <span aria-hidden="true" className={cn("status size-1.5 shrink-0 rounded-full", working ? "status-primary halo" : mission.seen === "needs_you" ? "status-warning" : "bg-current opacity-60")} />
      {seenAs(mission)}
    </span>
  );
}
