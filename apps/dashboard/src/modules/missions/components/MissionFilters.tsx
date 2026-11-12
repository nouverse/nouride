/**
 * What narrows the Missions list, beside its search: whose they are (an admin's alone to pick, as on Chats and
 * Automations), how far back the finished ones go, and one agent's.
 */

import { useNavigate } from "@tanstack/react-router";
import { useOrchestrator } from "@/commons/components/agents/AgentName";
import { PeopleFilter } from "@/commons/components/people/PeopleFilter";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import type { Whose } from "@/commons/hooks/use-whose";
import { agentOptions } from "@/commons/lib/agents";
import { NOBODYS } from "@/commons/lib/by-person";

/**
 * How far back the finished ones go: 3 days unless chosen, a month at most, the daemon's own bound
 * (`GET /missions?days=`).
 */
const SPANS = [3, 7, 14, 30] as const;
export type Span = (typeof SPANS)[number];

export function MissionFilters({
  picker,
  days,
  onDays,
  agent,
  agents,
}: {
  /** The people picker, for an admin; none for anyone else, who reads their own. */
  picker: { whose: Whose; setWhose: (next: Whose) => void } | null;
  days: Span;
  onDays: (next: Span) => void;
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
      <SearchSelect small label="Finished in" options={SPANS.map((span) => ({ value: String(span), label: `Last ${span} days` }))} value={String(days)} onChange={(next) => onDays(Number(next) as Span)} width={176} />
      {agents.length > 1 || agent ? (
        <SearchSelect small label="Agent" options={agentOptions(agents, orchestrator, agent)} value={agent ?? ""} onChange={(next) => void navigate({ to: "/missions", search: next ? { agent: next } : {} })} width={208} />
      ) : null}
    </>
  );
}
