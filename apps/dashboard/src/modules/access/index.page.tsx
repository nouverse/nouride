/**
 * Access — who may talk to the agents, for every agent at once.
 *
 * One page rather than a list on each agent's Access tab, because the question is about a person, not
 * an agent: one person can ask two bots, a spammer can tag six, and "who did we block?" has no agent in
 * it. Each agent's tab keeps what is that agent's — whether it takes new senders, how much it asks before
 * acting — and links here, filtered to it.
 *
 * Five tabs, the shape of a request's life: **Pending** (waiting, and the code runs out), **Approved**
 * (in), **Denied** (no for now, with the time left), **Blocked** (no until unblocked), **History**
 * (everything answered, from the audit log). Each list scrolls inside its own card, as Skills' do.
 */

import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Lock, Shield } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, PageHeader } from "@/commons/components/ui/ui";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ApprovedTab } from "./approved.tab";
import { BlockedTab } from "./blocked.tab";
import { DeniedTab } from "./denied.tab";
import { HistoryTab } from "./history.tab";
import { PendingTab } from "./pending.tab";
import type { AccessSearch, AccessTab } from "./search";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

const count = (n: number, tone = "badge-ghost") => (n > 0 ? <span className={`badge badge-xs ${tone} font-semibold`}>{n}</span> : null);

export default function AccessPage({ search, onSearch }: { search: AccessSearch; onSearch: (next: AccessSearch) => void }) {
  const access = useQuery({ queryKey: ["access"], queryFn: api.access, refetchInterval: 15_000, retry: false });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const tab: AccessTab = search.tab ?? "pending";

  const agentOf = (gatewayId: string) => gateways.data?.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst([...new Set((gateways.data?.gateways ?? []).map((gateway) => gateway.agent).filter((agent): agent is string => Boolean(agent)))].sort(), (id) => id);
  const inScope = (gatewayId: string) => !search.agent || agentOf(gatewayId) === search.agent;
  const senders = (access.data?.senders ?? []).filter((sender) => inScope(sender.gatewayId));
  const by = (status: string) => senders.filter((sender) => sender.status === status);
  const [pending, approved, denied, blocked] = [by("pending"), by("approved"), by("denied"), by("blocked")];
  // A bare id is honoured on every connection; a qualified one only on its own.
  const allowlist = (access.data?.allowlist ?? []).filter((id) => {
    const at = id.lastIndexOf(":");
    return at < 0 || inScope(id.slice(0, at));
  });

  const mode = access.data?.mode ?? "pair";
  const unreachable = access.error instanceof Error && /did not answer|cannot reach/i.test(access.error.message);

  return (
    // A tab's panel fades in as it is drawn (`*:animate-fade`), as every section that appears here does.
    <div className="space-y-6 *:animate-fade">
      <PageHeader
        ask={PAGE_ASKS.access}
        title="Access"
        description="Who may talk to your agents: who is waiting for an answer, who is in, who is kept out, and what was decided."
      />

      {access.error ? (
        <Card title={unreachable ? "Nouride is not answering" : "Access control is off"}>
          <p className="text-base-content/65 text-sm">
            {unreachable ? `${access.error.message}. Whoever runs this server can check that Nouride is running.` : "Access control is not turned on for this server, so there is nothing to list."}
          </p>
        </Card>
      ) : (
        <>
          <p className="text-base-content/65 text-sm flex items-start gap-2">
            {mode === "open" ? (
              <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
            ) : mode === "pair" ? (
              <Shield size={14} className="text-info mt-0.5 shrink-0" />
            ) : (
              <Lock size={14} className="text-success mt-0.5 shrink-0" />
            )}
            <span>
              {mode === "open"
                ? "Open: anyone who messages a bot is answered, without pairing."
                : mode === "pair"
                  ? "A stranger who messages a bot gets a pairing code and waits here."
                  : "New senders are turned away; only those already approved are answered."}{" "}
              That is the default; an agent can decide for itself on its own Access tab. Change the default on{" "}
              <Link to="/agents/settings" className="link link-primary">
                Agent Settings
              </Link>
              .
            </span>
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedTabs
              tabs={[
                { value: "pending", label: "Pending", after: count(pending.length, "badge-warning") },
                { value: "approved", label: "Approved", after: count(approved.length) },
                { value: "denied", label: "Denied", after: count(denied.length) },
                { value: "blocked", label: "Blocked", after: count(blocked.length) },
                { value: "history", label: "History" },
              ]}
              value={tab}
              onChange={(next) => onSearch({ ...search, tab: next })}
            />
            <SearchSelect
              small
              label="Agent"
              options={[{ value: "", label: "All agents" }, ...agents.map((agent) => ({ value: agent, label: agent === orchestrator ? `♛ ${agent}` : agent }))]}
              value={search.agent ?? ""}
              onChange={(next) => onSearch({ ...search, agent: next || undefined })}
              width={208}
            />
          </div>

          {access.isPending ? (
            <ListLoading />
          ) : tab === "pending" ? (
            <PendingTab senders={pending} agentOf={agentOf} pairingOn={mode !== "allowlist"} />
          ) : tab === "approved" ? (
            <ApprovedTab senders={approved} allowlist={allowlist} blocked={blocked} agentOf={agentOf} />
          ) : tab === "denied" ? (
            <DeniedTab senders={denied} agentOf={agentOf} />
          ) : tab === "blocked" ? (
            <BlockedTab senders={blocked} agentOf={agentOf} />
          ) : (
            <HistoryTab senders={access.data?.senders ?? []} agentOf={agentOf} inScope={inScope} />
          )}
        </>
      )}
    </div>
  );
}
