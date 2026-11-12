/**
 * Work's first tab (0.8.24): every tool call an agent is waiting on, answered here as in its chat, every step of an
 * automation that waits for a yes, answered here too, and every mission waiting for an answer, which opens its page.
 * Automations, missions and helpers are the section's other tabs (`SectionTabs`); this is the one that asks something
 * of you, so the menu's badge counts it and the section opens on it.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { ApprovalCard } from "@/commons/components/approvals/ApprovalCard";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { WaitingLink } from "@/commons/components/approvals/WaitingLink";
import { WaitingStepCard } from "@/commons/components/jobs/WaitingStepCard";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { MOVING_MISSIONS, missionsWaiting } from "@/commons/hooks/use-needs-you";
import { useWaitingSteps } from "@/commons/hooks/use-waiting-steps";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { canWrite, useMe } from "@/commons/lib/session";

export default function WorkPage() {
  const me = useMe();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 5_000, retry: false });
  // Its outcome is a toast (the hook says why): an error inside a card went with the card on the next poll.
  const answer = useAnswerApproval();
  const missions = useQuery({ queryKey: MOVING_MISSIONS, queryFn: () => api.missions(), refetchInterval: 15_000, retry: false });
  const steps = useWaitingSteps();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, staleTime: 30_000 });
  const pending = approvals.data?.pending ?? [];
  const asking = missionsWaiting(missions.data?.missions ?? []);
  const waiting = steps.data?.waiting ?? [];
  const name = (id: string) => status.data?.agents.find((agent) => agent.id === id)?.displayName || id;
  return (
    <div className="space-y-5">
      <PageHeader ask={PAGE_ASKS.work} title="Work" description="What your agents are doing on their own, and what they are waiting for you to answer." />
      {approvals.error ? (
        <ErrorNote error={approvals.error} />
      ) : approvals.isPending ? (
        <ListLoading shape="cards" count={2} />
      ) : pending.length + asking.length + waiting.length === 0 ? (
        <EmptyState pose="approved" title="Nothing is waiting for you" description="When an agent needs your yes before it goes on, it shows here and in its chat." />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {pending.map((request) => (
            <ApprovalCard key={request.id} request={request} pending={answer.isPending} onAnswer={(request, decision) => answer.mutate({ request, decision })} />
          ))}
          {waiting.map((step) => (
            <WaitingStepCard key={step.runId} step={step} agent={name(step.agentId)} canAnswer={canWrite(me.data ?? null)} />
          ))}
          {asking.map((mission) => (
            <WaitingLink key={mission.id} to="/missions/$missionId" params={{ missionId: mission.id }} tag={`Mission · ${name(mission.agentId)}`} title={mission.goal} line="Waiting for your answer" />
          ))}
        </div>
      )}
    </div>
  );
}
