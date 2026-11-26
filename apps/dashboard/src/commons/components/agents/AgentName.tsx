/**
 * An agent's id as every list and chip shows it: the orchestrator — the one that answers when nobody is named — with a
 * crown, and first. One component and one hook, so a page that lists agents cannot forget either.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crown, Globe } from "lucide-react";
import type { AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";
import { cn } from "@/commons/lib/utils";
import { RowTag } from "@/commons/components/chat/ConversationRow";

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

/** Beside an agent's name where there is room for words — the Agents list, Home, Memory's notes. */
export function OrchestratorBadge() {
  return (
    <span className="badge badge-xs badge-primary gap-1 font-semibold px-2 py-1 shadow-xs font-mono">
      <Crown size={10} /> orchestrator
    </span>
  );
}

/** What "Open" on an agent means, in full: the badge says one word, so its title says the rest. */
export const OPEN_TO_EVERYONE = "Open to everyone: anyone may write to it";

/**
 * An agent open to everyone, beside its name where the orchestrator's crown would be: the Agents list and its page.
 * One short word, so a long name is what gives way in a narrow row; the badge itself is never cut or wrapped.
 */
export function OpenBadge({ size = "xs" }: { size?: "xs" | "sm" }) {
  return (
    <span
      className={cn("badge badge-soft badge-secondary shrink-0 gap-1 whitespace-nowrap px-2 py-1 font-mono font-semibold", size === "sm" ? "badge-sm" : "badge-xs")}
      title={OPEN_TO_EVERYONE}
      aria-label={OPEN_TO_EVERYONE}
      data-open-badge
    >
      <Globe size={size === "sm" ? 11 : 10} aria-hidden="true" /> Open
    </span>
  );
}

/** The word after an agent's name in a chat list's row: the orchestrator, or an agent open to everyone, else none. */
export function agentTag(agent: Pick<AgentSummary, "id" | "access">, orchestrator: string | null): ReactNode {
  if (agent.id === orchestrator) return <RowTag>Orchestrator</RowTag>;
  if (agent.access === "open") {
    return (
      <RowTag title={OPEN_TO_EVERYONE}>
        <Globe size={10} aria-hidden="true" /> Open
      </RowTag>
    );
  }
  return undefined;
}
