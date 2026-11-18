/**
 * One finished mission as a row of the list under the board: how it ended, its title whole (which opens its page), who
 * stopped it or why it failed, its agent, how far its checklist got, and when it ended. A row and not a card: what has
 * been is read down a list, and a title cut to a column's width said too little.
 */

import { Link } from "@tanstack/react-router";
import type { MissionView } from "@nouride/wire";
import { Tag } from "@/commons/components/ui/Tag";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { readsOnly, whoseWords } from "@/commons/lib/by-person";
import { missionName } from "@/commons/lib/mission-name";
import { cn } from "@/commons/lib/utils";
import { Lit } from "@/commons/components/ui/Lit";
import { ENTER, type Motion } from "@/commons/hooks/use-motion-list";
import { badgeOf, cardLine, outcomeOf } from "../lib/board";
import { WhenLine } from "./WhenLine";

const TONE = { done: "bg-success/12 text-success", failed: "bg-failed/15 text-failed", stopped: "bg-base-content/[0.07] text-base-content/70" };

export function FinishedRow({ mission, motion = "", showWhose }: { mission: MissionView; motion?: Motion; showWhose: boolean }) {
  const face = useAgentFace(mission.agentId);
  const line = cardLine(mission);
  const list = mission.checklist;
  return (
    <li data-mission={mission.id} data-column="finished" className={cn("relative flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3", motion)}>
      {/* One that just ended arrives lit, as a card that changes column does. */}
      <Lit state={`${mission.status} ${mission.seen}`} arrived={motion === ENTER} />
      <span className={cn("w-20 shrink-0 rounded-full px-2.5 py-0.5 text-center text-xs font-semibold", TONE[outcomeOf(mission)])} data-badge>
        {badgeOf(mission)}
      </span>
      <span className="min-w-[14rem] flex-1">
        <Link to="/missions/$missionId" params={{ missionId: mission.id }} className="text-sm font-semibold leading-snug tracking-tight text-base-content hover:underline [overflow-wrap:anywhere]" title={mission.goal}>
          {missionName(mission)}
        </Link>
        {line ? (
          <span className="block text-xs text-base-content/65 line-clamp-1 [overflow-wrap:anywhere]" data-line>
            <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider">{line.label}</span>
            {line.text}
          </span>
        ) : null}
      </span>
      {showWhose || readsOnly(mission) ? <Tag title={readsOnly(mission) ? "You can read this one, not change it" : undefined}>{whoseWords(mission)}</Tag> : null}
      <span className="w-24 shrink-0 truncate text-xs text-base-content/80">{face?.name ?? mission.agentId}</span>
      <span className="w-28 shrink-0 font-mono text-[11px] tabular-nums text-base-content/65">{list ? `${list.done} of ${list.total} steps` : ""}</span>
      <WhenLine mission={mission} className="w-32 shrink-0 lg:text-right" />
    </li>
  );
}
