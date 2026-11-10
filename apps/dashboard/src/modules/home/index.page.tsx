/**
 * Home (0.8.24, where Overview was): an inbox before a dashboard. In the design rules' order: what needs the person,
 * answered here where it can be; what is moving; a quick line to an agent; and the agents, the Office's picture with
 * each one as a chip. The box's state sits in the greeting's corner, its warnings under it; today's use at the foot. When nothing waits and nothing moves, the cat rests where the cards would be, and while missions move it rides beside them: a different picture each visit (`moments.ts`).
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/commons/lib/api";
import type { HealthPayload } from "@nouride/wire";
import { orchestratorFirst } from "@/commons/lib/agents";
import { looksOf } from "@/commons/cat/look";
import { useMe } from "@/commons/lib/session";
import { MOVING_MISSIONS, missionsWaiting, needsYouWords, useNeedsYou } from "@/commons/hooks/use-needs-you";
import { EmptyState } from "@/commons/components/ui/ui";
import { Mascot } from "@/commons/components/brand/Mascot";
import { Hero, greetingAt } from "./components/Hero";
import { HomeLoading } from "./components/HomeLoading";
import { NeedsYouCards } from "./components/NeedsYou";
import { MovingNow, moving } from "./components/MovingNow";
import { QuickChat } from "./components/QuickChat";
import { OfficeTeaser } from "./components/OfficeTeaser";
import { BoxLine, BoxWarnings } from "./components/BoxStatus";
import { UsageCard } from "./components/UsageCard";
import { SetupNotes } from "./components/SetupNotes";
import { CHAT_BUTTON_ROOM, NewChatButton } from "./components/NewChatButton";
import { QUIET, movingPoses, pickMoment } from "./moments";

/** "2 agents awake · 1 mission moving · 1 thing needs you": what is going on, in one line. */
export function summaryLine(awake: number, movingNow: number, needs: number): string {
  const parts = [
    awake > 0 ? `${awake} ${awake === 1 ? "agent" : "agents"} awake` : null,
    movingNow > 0 ? `${movingNow} ${movingNow === 1 ? "mission" : "missions"} moving` : null,
    needsYouWords(needs),
  ];
  return parts.filter(Boolean).join(" · ");
}

export default function HomePage() {
  const health = useQuery<HealthPayload>({ queryKey: ["health"], queryFn: api.health, refetchInterval: 10_000 });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 10_000 });
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 5_000, retry: false });
  const missions = useQuery({ queryKey: MOVING_MISSIONS, queryFn: () => api.missions(), refetchInterval: 15_000, retry: false });
  const needs = useNeedsYou();
  const me = useMe();
  // This visit's two pictures, picked once: the page polls, and neither changes under the person's eyes.
  const [resting] = useState(() => QUIET[pickMoment("quiet", QUIET.length)] ?? QUIET[0]!);
  const [riding] = useState(() => {
    const poses = movingPoses(greetingAt(new Date().getHours()).night);
    return poses[pickMoment("moving", poses.length)] ?? poses[0]!;
  });

  const agents = orchestratorFirst(status.data?.agents ?? [], status.data?.orchestrator);
  const looks = useMemo(() => looksOf(agents), [agents]);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.displayName || agent.id])), [agents]);

  if (health.isPending) return <HomeLoading />;

  if (health.error || !health.data) {
    return (
      <EmptyState pose="offline" title="Nouride is not answering" description="Whoever runs this server can check that Nouride is running." />
    );
  }

  const all = missions.data?.missions ?? [];
  const waiting = missionsWaiting(all);
  const movingNow = moving(all);
  const awake = agents.filter((agent) => agent.enabled && agent.state === "running" && agent.activity?.activity !== "asleep").length;
  const name = me.data?.user?.displayName?.trim() || "";
  const quiet = needs.total === 0 && movingNow.length === 0;
  const pendingApprovals = approvals.data?.pending ?? [];

  return (
    // Room under the last card for "+ Chat", which floats over the page's foot on a phone (`NewChatButton`): it lay on
    // the last card's corner once the page was scrolled to its end.
    <div className={`space-y-6 ${CHAT_BUTTON_ROOM}`}>
      <Hero name={name} line={summaryLine(awake, movingNow.length, needs.total)} aside={<BoxLine health={health.data} />} />
      <BoxWarnings health={health.data} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <NeedsYouCards approvals={pendingApprovals} missions={waiting} requests={needs.requests} skills={needs.skills} facts={needs.facts} documents={needs.documents} names={names} />
        {/* One cat beside the cards: where an approval waits it is the one pointing at it. */}
        {movingNow.length > 0 && <MovingNow missions={movingNow} looks={looks} names={names} {...(pendingApprovals.length === 0 ? { pose: riding } : {})} />}
        {quiet && (
          <section className="flex items-center justify-between gap-4 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5 lg:col-span-2">
            <div className="space-y-1">
              <p className="font-display text-lg font-medium text-base-content">Nothing is waiting for you</p>
              <p className="text-sm text-base-content/65">{resting.line}</p>
            </div>
            {/* After the words, at the card's far side: the greeting's cat over it stands before its words. */}
            <Mascot pose={resting.pose} decorative className="w-24 sm:w-28" />
          </section>
        )}
        <QuickChat agents={agents} orchestrator={status.data?.orchestrator ?? null} />
      </div>

      <OfficeTeaser agents={status.data?.agents ?? []} orchestrator={status.data?.orchestrator ?? null} />

      <UsageCard />
      <SetupNotes />

      <NewChatButton />
    </div>
  );
}
