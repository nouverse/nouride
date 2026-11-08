/**
 * Home (0.8.24, where Overview was): an inbox before a dashboard. In the design rules' order: what needs the person,
 * answered here where it can be; what is moving; a quick line to an agent; and the agents. Below them, the box and
 * today's use. When nothing waits and nothing moves, the cat sleeps where the cards would be.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { api, type HealthPayload } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";
import { looksOf } from "@/commons/cat/look";
import { useMe } from "@/commons/lib/session";
import { MOVING_MISSIONS, missionsWaiting, needsYouWords, useNeedsYou } from "@/commons/hooks/use-needs-you";
import { EmptyState } from "@/commons/components/ui/ui";
import { Mascot } from "@/commons/components/brand/Mascot";
import { Hero } from "./components/Hero";
import { NeedsYouCards } from "./components/NeedsYou";
import { MovingNow, moving } from "./components/MovingNow";
import { QuickChat } from "./components/QuickChat";
import { YourAgents } from "./components/YourAgents";
import { BoxStatus } from "./components/BoxStatus";
import { UsageCard } from "./components/UsageCard";
import { SetupNotes } from "./components/SetupNotes";
import { NewChatButton } from "./components/NewChatButton";

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

  const agents = orchestratorFirst(status.data?.agents ?? [], status.data?.orchestrator);
  const looks = useMemo(() => looksOf(agents), [agents]);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.displayName || agent.id])), [agents]);

  if (health.isPending) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-secondary" size={28} />
        <span className="text-sm font-medium text-base-content/65">Connecting to Nouride…</span>
      </div>
    );
  }

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

  return (
    <div className="space-y-6">
      <Hero name={name} line={summaryLine(awake, movingNow.length, needs.total)} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <NeedsYouCards approvals={approvals.data?.pending ?? []} missions={waiting} requests={needs.requests} skills={needs.skills} facts={needs.facts} documents={needs.documents} names={names} />
        {movingNow.length > 0 && <MovingNow missions={movingNow} looks={looks} names={names} />}
        {quiet && (
          <section className="flex items-center gap-4 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5 lg:col-span-2">
            <Mascot pose="sleeping" decorative className="w-24 sm:w-28" />
            <div className="space-y-1">
              <p className="font-display text-lg font-medium text-base-content">Nothing is waiting for you</p>
              <p className="text-sm text-base-content/65">Your agents nap until something comes in.</p>
            </div>
          </section>
        )}
        <QuickChat agents={agents} />
      </div>

      <YourAgents agents={agents} looks={looks} />

      <BoxStatus health={health.data} />
      <UsageCard />
      <SetupNotes />

      <NewChatButton />
    </div>
  );
}
