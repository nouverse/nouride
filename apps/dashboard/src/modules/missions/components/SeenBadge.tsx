/** What a person sees a mission as — working, needs you and with what, done, ended — as a capsule, the same on both pages. */

import type { MissionView } from "@nouride/wire";
import { cn } from "@/commons/lib/utils";
import { seenAs, seenTone, waitsElsewhere } from "../lib/mission";

export function SeenBadge({ mission, className }: { mission: Pick<MissionView, "seen" | "status" | "waitKind" | "startedAt" | "changeable" | "person">; className?: string }) {
  const working = mission.seen === "working" && mission.status === "running";
  const needsReader = mission.seen === "needs_you" && !waitsElsewhere(mission);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold whitespace-nowrap",
        seenTone(mission),
        className,
      )}
    >
      {/* A live dot only where something is happening now: daisyUI's status, with the theme's halo. */}
      <span aria-hidden="true" className={cn("status size-1.5 shrink-0 rounded-full", working ? "status-primary halo" : needsReader ? "status-warning" : "bg-current opacity-60")} />
      {seenAs(mission)}
    </span>
  );
}
