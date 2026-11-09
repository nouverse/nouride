/**
 * The plan beside the chat (0.8.0): the checklist the agent keeps for this conversation, and the
 * missions working from it, above the composer — read only, the agent's to keep.
 *
 * Nobody saw a plan unless they opened the Notes drawer or a mission's page, so a person waiting on long work saw a
 * spinner and nothing of how far along it was. One line each — how many steps are done and the one in hand — and the
 * whole plan a press away. A finished plan is let go when its turn ends (`settleNotes`), and the strip with it.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, ListChecks, Target } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionView, NotesPlan } from "@nouride/wire";
import { stepsDone } from "../lib/notes";
import { PlanSteps } from "./PlanSteps";

/** How a mission's line reads its state: what it is doing, or that it needs the person. */
const MISSION_STATE: Record<MissionView["status"], string> = {
  queued: "waiting for a slot",
  running: "working",
  checking: "checking",
  waiting: "needs you",
  done: "done",
  failed: "ended",
  stopped: "stopped",
};

/** A mission that has ended is on its own page and the Missions list, not here. */
const ENDED = new Set<MissionView["status"]>(["done", "failed", "stopped"]);

export function PlanStrip({ plan, chat, busy }: { plan?: NotesPlan | undefined; chat: { gatewayId: string; chatId: string } | null; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const here = (one: MissionView) => one.chatId === chat?.chatId && one.gatewayId === chat?.gatewayId && !ENDED.has(one.status);
  /**
   * The missions this conversation started. Read again when a turn ends (`use-conversation.ts`), which is when an agent
   * starts one, and every ten seconds while a turn runs or one of them works.
   */
  const listed = useQuery({
    queryKey: ["missions", "chat"],
    queryFn: () => api.missions(),
    enabled: chat !== null,
    refetchInterval: (query) => (busy || (query.state.data?.missions ?? []).some(here) ? 10_000 : false),
    retry: false,
  });
  const missions = (listed.data?.missions ?? []).filter(here);
  const steps = plan?.steps ?? [];
  if (steps.length === 0 && missions.length === 0) return null;
  const active = steps.find((step) => step.state === "active");

  return (
    <div className="mx-3 mb-2 space-y-1 rounded-xl border border-base-content/[0.08] bg-base-100/80 px-3 py-2 text-xs">
      {plan && steps.length > 0 && (
        <>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 text-left"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <ListChecks size={14} aria-hidden="true" className="shrink-0 text-primary" />
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-base-content/65">Plan</span>
            <span className="shrink-0 font-mono text-base-content/75">
              {stepsDone(steps)} of {steps.length}
            </span>
            {active && <span className="min-w-0 truncate text-base-content">{active.text}</span>}
            {open ? <ChevronUp size={14} aria-hidden="true" className="ml-auto shrink-0" /> : <ChevronDown size={14} aria-hidden="true" className="ml-auto shrink-0" />}
          </button>
          {open && <PlanSteps plan={plan} />}
        </>
      )}
      {missions.map((mission) => (
        <Link
          key={mission.id}
          to="/missions/$missionId"
          params={{ missionId: mission.id }}
          className="flex min-w-0 items-center gap-2 rounded-lg hover:bg-base-200/60"
        >
          <Target size={14} aria-hidden="true" className="shrink-0 text-primary" />
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-base-content/65">Mission</span>
          <span className="shrink-0 font-mono text-base-content/75">
            {mission.checklist ? `${mission.checklist.done} of ${mission.checklist.total}` : MISSION_STATE[mission.status]}
          </span>
          <span className="min-w-0 truncate text-base-content">
            {mission.status === "waiting" ? `needs you: ${mission.reason ?? mission.goal}` : (mission.checklist?.active ?? mission.goal)}
          </span>
        </Link>
      ))}
    </div>
  );
}
