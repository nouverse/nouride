/**
 * What is moving (0.8.24): each mission at work, by the agent doing it, with how far along its checklist is when it has
 * one. A mission without a checklist says it is working, rather than drawing a bar that guesses.
 */

import { Link } from "@tanstack/react-router";
import type { Look } from "@/commons/cat/look";
import type { MissionView } from "@/commons/lib/api";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { ProgressBar } from "@/commons/components/ui/ProgressBar";
import { Tag } from "@/commons/components/ui/Tag";

const MOVING = new Set<MissionView["status"]>(["queued", "running", "checking"]);

/** The missions at work: queued, running, or being checked. */
export function moving(missions: readonly MissionView[]): MissionView[] {
  return missions.filter((mission) => MOVING.has(mission.status));
}

export function MovingNow({ missions, looks, names }: { missions: MissionView[]; looks: Map<string, Look>; names: Map<string, string> }) {
  return (
    <section className="space-y-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5">
      <Tag tone="moving">Moving now</Tag>
      <ul className="space-y-3">
        {missions.slice(0, 4).map((mission) => {
          const look = looks.get(mission.agentId);
          const name = names.get(mission.agentId) ?? mission.agentId;
          const checklist = mission.checklist;
          return (
            <li key={mission.id}>
              <Link to="/missions/$missionId" params={{ missionId: mission.id }} className="flex items-center gap-3 rounded-[14px]">
                {look && <AgentAvatar look={look} name={name} size="sm" />}
                <span className="min-w-0 flex-1 space-y-1.5">
                  <span className="block truncate text-sm font-semibold text-base-content">{mission.goal}</span>
                  {checklist && checklist.total > 0 ? (
                    <ProgressBar done={checklist.done} total={checklist.total} label={`${name}: ${checklist.done} of ${checklist.total} done`} />
                  ) : (
                    <span className="block text-xs text-base-content/65">{mission.status === "queued" ? `${name} starts it soon` : mission.status === "checking" ? `${name} is checking the work` : `${name} is working on it`}</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {missions.length > 4 && (
        <Link to="/missions" className="link link-hover text-sm text-base-content/70">
          and {missions.length - 4} more
        </Link>
      )}
    </section>
  );
}
