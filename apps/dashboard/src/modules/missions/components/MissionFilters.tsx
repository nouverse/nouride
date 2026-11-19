/**
 * What narrows the Missions board, beside its search: whose they are (an admin's alone to pick, as on Chats and
 * Automations), and one agent's. How far back the finished ones go is Finished's own (`MissionBoard`).
 */

import { useNavigate } from "@tanstack/react-router";
import { useOrchestrator } from "@/commons/components/agents/AgentName";
import { PeopleFilter } from "@/commons/components/people/PeopleFilter";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import type { Whose } from "@/commons/hooks/use-whose";
import { agentOptions } from "@/commons/lib/agents";
import { NOBODYS } from "@/commons/lib/by-person";

export function MissionFilters({
  picker,
  agent,
  agents,
}: {
  /** The people picker, for an admin; none for anyone else, who reads their own. */
  picker: { whose: Whose; setWhose: (next: Whose) => void } | null;
  /** The agent the address names (`?agent=`), as an agent's page links here: the daemon then sends that agent's only. */
  agent: string | undefined;
  /** Every agent's id, the orchestrator first. */
  agents: readonly string[];
}) {
  const navigate = useNavigate();
  const orchestrator = useOrchestrator();
  return (
    <>
      {picker ? <PeopleFilter small value={picker.whose} onChange={picker.setWhose} label="Whose missions" nobody={NOBODYS} /> : null}
      {agents.length > 1 || agent ? (
        <SearchSelect small label="Agent" options={agentOptions(agents, orchestrator, agent)} value={agent ?? ""} onChange={(next) => void navigate({ to: "/missions", search: next ? { agent: next } : {} })} width={208} />
      ) : null}
    </>
  );
}
