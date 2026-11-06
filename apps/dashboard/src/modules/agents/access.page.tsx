/**
 * Who may talk to this agent, and how much it asks them before it acts.
 *
 * The two belong on one page: "who is allowed in" and "what happens once they are" are the same
 * decision seen from either end, and the approval level is the only one of the pair that cannot be set
 * anywhere else — see `ApprovalLevel`. The senders themselves are on the Access page, for every agent at
 * once; here is this agent's count of them, and the way there.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { AccessSummary } from "./components/AccessSummary";
import { AgentAccessMode } from "./components/AgentAccessMode";
import { ApprovalLevel } from "./components/ApprovalLevel";
import { SecondLook } from "./components/SecondLook";

export default function AgentAccessPage({ agentId }: { agentId: string }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agent = status.data?.agents.find((candidate) => candidate.id === agentId);

  return (
    <div className="space-y-6">
      {agent ? <AgentAccessMode agent={agent} /> : null}
      {/* Beside the switch: both are "who gets in", and what waits there should not be below the fold. */}
      <AccessSummary agentId={agentId} />
      {agent ? <ApprovalLevel agent={agent} /> : null}
      {agent ? <SecondLook agent={agent} /> : null}
    </div>
  );
}
