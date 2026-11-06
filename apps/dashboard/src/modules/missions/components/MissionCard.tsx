/**
 * One mission as a card, laid out as the Knowledge tab lays out a collection (0.8.20, the owner's ask): its goal and how
 * it stands, how far along its checklist is, and one line that says the most useful thing about it now — the step it is
 * on while it works, what it waits for while it needs you, how it ended once it has. The whole card opens its page.
 */

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { MissionView } from "@/commons/lib/api";
import { CARD } from "@/commons/components/ui/CardGrid";
import { ago } from "@/commons/lib/format";
import { cn } from "@/commons/lib/utils";
import { missionTitle, rowLine } from "../lib/mission";
import { SeenBadge } from "./SeenBadge";

export function MissionCard({ mission }: { mission: MissionView }) {
  const list = mission.checklist;
  const line = rowLine(mission);
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: mission.id }}
      className={cn(CARD, "group hover:border-base-content/20 active:scale-[0.99]")}
    >
      {/* The badge on a line of its own: "Needs you · a question" beside the goal left it a word or two a line. */}
      <header className="space-y-2.5">
        <SeenBadge mission={mission} />
        <h3 className="text-sm font-semibold leading-snug tracking-tight text-base-content line-clamp-2 [overflow-wrap:anywhere]" title={mission.goal}>
          {missionTitle(mission.goal)}
        </h3>
      </header>

      <div className="flex items-center gap-3">
        {list ? (
          <>
            <progress
              className={`progress h-1.5 flex-1 ${mission.seen === "done" ? "progress-success" : mission.seen === "ended" ? "progress-secondary" : "progress-primary"}`}
              value={list.done}
              max={list.total}
              aria-label={`${list.done} of ${list.total} steps done`}
            />
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-base-content/70">
              {list.done} of {list.total} steps
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] text-base-content/65">no checklist yet</span>
        )}
      </div>

      {line && (
        <p className="text-xs leading-relaxed text-base-content/75 line-clamp-2 [overflow-wrap:anywhere]">
          <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">{line.label}</span>
          {line.text}
        </p>
      )}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="font-mono text-xs text-base-content/65">
          {mission.agentId} · {ago(mission.createdAt)}
        </span>
        {/* Drawn as the Knowledge tab's Open button; the card around it is the link. */}
        <span className="btn btn-primary btn-sm gap-1 rounded-xl">
          Open <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </footer>
    </Link>
  );
}
