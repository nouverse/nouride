/**
 * An agent's id as every list and chip shows it: the orchestrator — the one that answers when nobody is named — with a
 * crown, and first. One component and one hook, so a page that lists agents cannot forget either.
 */

import { useQuery } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { api } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";

/** Which agent is the orchestrator, from `/status` — the same query every page already holds. */
export function useOrchestrator(): string | null {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  return status.data?.orchestrator ?? null;
}

/** `items`, the orchestrator's first; `idOf` says which agent each item is. */
export function useOrchestratorFirst<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const orchestrator = useOrchestrator();
  return orchestratorFirst(items.map((item) => ({ id: idOf(item), item })), orchestrator).map((entry) => entry.item);
}

export function AgentName({ id, orchestrator, size = 11 }: { id: string; orchestrator: string | null; size?: number }) {
  return (
    <>
      {id === orchestrator ? <Crown size={size} className="shrink-0" aria-label="orchestrator" /> : null}
      {id}
    </>
  );
}

/** Beside an agent's name where there is room for words — the Agents list, Overview, Memory's notes. */
export function OrchestratorBadge() {
  return (
    <span className="badge badge-xs badge-primary gap-1 font-semibold px-2 py-1 shadow-xs font-mono">
      <Crown size={10} /> orchestrator
    </span>
  );
}
