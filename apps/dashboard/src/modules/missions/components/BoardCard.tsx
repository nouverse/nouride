/**
 * One mission on the board: its badge, its title (which opens its page), its bar, the line that matters in its column,
 * and the agent's own cat with its name and one time line, the day behind it a hover away (`WhenLine`). A draft is
 * started from the card and a question answered from it; deleting a draft stays on its page, where what goes with it
 * is said first.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { MissionView } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { Tag } from "@/commons/components/ui/Tag";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { readsOnly, whoseWords } from "@/commons/lib/by-person";
import { missionName } from "@/commons/lib/mission-name";
import { cn } from "@/commons/lib/utils";
import { Lit } from "@/commons/components/ui/Lit";
import { ENTER, type Motion } from "@/commons/hooks/use-motion-list";
import { useMissionAct } from "../hooks/use-mission-act";
import { actionsFor } from "../lib/mission";
import { badgeOf, barFill, cardLine, columnOf, outcomeOf } from "../lib/board";
import { WhenLine } from "./WhenLine";

/** The badge's tint by column, and by how a finished one ended. */
function badgeTone(mission: MissionView): string {
  const column = columnOf(mission);
  if (column === "backlog") return "bg-secondary/12 text-secondary";
  if (column === "needs") return "bg-warning/15 text-warning";
  if (column === "working") return "bg-primary/12 text-primary";
  return { done: "bg-success/12 text-success", failed: "bg-failed/15 text-failed", stopped: "bg-base-content/[0.07] text-base-content/70" }[outcomeOf(mission)];
}

/** `motion`: how its column draws it (`useMotionList`); one that arrives is lit too. */
export function BoardCard({ mission, motion = "", writable, showWhose }: { mission: MissionView; motion?: Motion; writable: boolean; showWhose: boolean }) {
  const face = useAgentFace(mission.agentId);
  const act = useMissionAct(mission.id);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const column = columnOf(mission);
  const line = cardLine(mission);
  const list = mission.checklist;
  const mayAct = writable && !readsOnly(mission);
  const startable = column === "backlog" && mayAct;
  const answerable = column === "needs" && mayAct && actionsFor(mission).includes("answer");

  return (
    <article data-mission={mission.id} data-column={column} className={cn("relative space-y-3 rounded-[18px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft", motion)}>
      <Lit state={`${mission.status} ${mission.seen}`} arrived={motion === ENTER} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", badgeTone(mission))} data-badge>
          {badgeOf(mission)}
        </span>
        {showWhose || readsOnly(mission) ? <Tag title={readsOnly(mission) ? "You can read this one, not change it" : undefined}>{whoseWords(mission)}</Tag> : null}
      </div>
      <h3 className="text-sm font-semibold leading-snug tracking-tight text-base-content [overflow-wrap:anywhere]">
        <Link to="/missions/$missionId" params={{ missionId: mission.id }} className="line-clamp-2 hover:underline max-sm:-my-3.5 max-sm:py-3.5" title={mission.goal}>
          {missionName(mission)}
        </Link>
      </h3>

      {list ? (
        <div className="flex items-center gap-3">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-base-content/10" role="progressbar" aria-valuemin={0} aria-valuemax={list.total} aria-valuenow={list.done} aria-label={`${list.done} of ${list.total} steps done`}>
            <span className={cn("block h-full rounded-full", barFill(mission))} data-bar style={{ width: `${list.total > 0 ? Math.round((list.done / list.total) * 100) : 0}%` }} />
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-base-content/70">
            {list.done} of {list.total} steps
          </span>
        </div>
      ) : null}

      {line ? (
        <p className="text-xs leading-relaxed text-base-content/75 line-clamp-3 [overflow-wrap:anywhere]" data-line>
          <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">{line.label}</span>
          {line.text}
        </p>
      ) : null}

      <div className="flex items-center gap-2.5">
        {face?.look ? <AgentAvatar look={face.look} name={face.name} size="xs" /> : null}
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-base-content">{face?.name ?? mission.agentId}</span>
          <WhenLine mission={mission} />
        </span>
      </div>

      {startable || answerable ? (
        <div className="flex flex-wrap items-center gap-2">
          {startable ? (
            <button type="button" className="btn btn-primary btn-sm min-h-11 rounded-xl px-4 sm:min-h-8" disabled={act.isPending} onClick={() => act.mutate({ verb: "accept" })}>
              Start
            </button>
          ) : null}
          {answerable && !answering ? (
            <button type="button" className="btn btn-primary btn-sm min-h-11 w-full rounded-xl sm:min-h-8 sm:w-auto" onClick={() => setAnswering(true)}>
              Answer
            </button>
          ) : null}
          {startable ? (
            <Link to="/missions/$missionId" params={{ missionId: mission.id }} className="btn btn-ghost btn-sm min-h-11 rounded-xl sm:min-h-8">
              Open
            </Link>
          ) : null}
        </div>
      ) : null}

      {answering ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!answer.trim()) return;
            act.mutate({ verb: "answer", text: answer.trim() }, { onSuccess: () => (setAnswering(false), setAnswer("")) });
          }}
        >
          <textarea className="textarea textarea-sm w-full rounded-xl" rows={2} aria-label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} autoFocus />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm min-h-11 rounded-xl sm:min-h-8" disabled={act.isPending || !answer.trim()}>
              Send
            </button>
            <button type="button" className="btn btn-ghost btn-sm min-h-11 rounded-xl sm:min-h-8" onClick={() => setAnswering(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
