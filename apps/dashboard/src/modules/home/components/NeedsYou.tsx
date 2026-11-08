/**
 * What waits for the person, first on Home (0.8.24). A tool call an agent is blocked on is answered right here, as it
 * was on Overview. A mission waiting for an answer, a skill to review, a person asking to talk to the agents, a fact to
 * keep or drop and a document to add each say what they are and open the page that decides them: approving a stranger is not undone by looking away, so it is
 * never a button on a page people skim (`mount.test.ts`, "pending work is announced").
 */

import type { ApprovalRequest, MissionView } from "@nouride/wire";
import { ApprovalCard } from "@/commons/components/approvals/ApprovalCard";
import { WaitingLink } from "@/commons/components/approvals/WaitingLink";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";

export function NeedsYouCards({
  approvals,
  missions,
  requests,
  skills,
  facts,
  documents,
  names,
}: {
  approvals: ApprovalRequest[];
  missions: MissionView[];
  requests: number;
  skills: number;
  facts: number;
  documents: { collection: string; name: string; count: number }[];
  names: Map<string, string>;
}) {
  // Its outcome is a toast (the hook says why): an error inside the card went with the card on the next poll.
  const answer = useAnswerApproval();
  return (
    <>
      {approvals.map((request, at) => (
        <ApprovalCard key={request.id} request={request} mascot={at === 0} pending={answer.isPending} onAnswer={(request, decision) => answer.mutate({ request, decision })} />
      ))}
      {missions.map((mission) => (
        <WaitingLink key={mission.id} to="/missions/$missionId" params={{ missionId: mission.id }} tag={`Mission · ${names.get(mission.agentId) ?? mission.agentId}`} title={mission.goal} line="Waiting for your answer" />
      ))}
      {requests > 0 && (
        <WaitingLink to="/access" tag="Access" title={requests === 1 ? "Someone asks to talk to your agents" : `${requests} people ask to talk to your agents`} line="See who is asking" />
      )}
      {skills > 0 && (
        <WaitingLink to="/skills" tag="Skills" title={skills === 1 ? "A new skill waits for your review" : `${skills} new skills wait for your review`} line="Review them" />
      )}
      {facts > 0 && (
        <WaitingLink to="/memories" search={{ tab: "proposals" }} tag="Memory" title={facts === 1 ? "A fact waits for your yes or no" : `${facts} facts wait for your yes or no`} line="Review them" />
      )}
      {documents.map((one) => (
        <WaitingLink key={one.collection} to="/memories" search={{ tab: "knowledge" }} tag="Knowledge" title={one.count === 1 ? `A document waits to be added to ${one.name}` : `${one.count} documents wait to be added to ${one.name}`} line="Add or decline" />
      ))}
    </>
  );
}
