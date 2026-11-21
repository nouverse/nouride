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
import { useState } from "react";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { StickyBar } from "@/commons/components/ui/StickyBar";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ApprovedTab } from "./approved.tab";
import { BlockedTab } from "./blocked.tab";
import { DeniedTab } from "./denied.tab";
import { HistoryTab } from "./history.tab";
import { PendingTab } from "./pending.tab";
import type { AccessSearch, AccessTab } from "./search";
import { SenderQuery } from "./sender-line";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

const count = (n: number, tone = "badge-ghost") => (n > 0 ? <span className={`badge badge-xs ${tone} font-semibold`}>{n}</span> : null);

export default function AccessPage({ search, onSearch }: { search: AccessSearch; onSearch: (next: AccessSearch) => void }) {
  /**
   * What the Approved tab was asked to find among everyone approved, where they are more than a listing holds: a
   * list let in from a file may be thousands, and the page is sent the newest of them.
   */
  const [found, setFound] = useState("");
  const access = useQuery({ queryKey: found ? ["access", found] : ["access"], queryFn: () => api.access(found || undefined), refetchInterval: 15_000, retry: false });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const tab: AccessTab = search.tab ?? "pending";
  /** One filter for whichever tab is open, in the row that stays at the top of the window. */
  const [query, setQuery] = useState("");

  const agentOf = (gatewayId: string) => gateways.data?.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst([...new Set((gateways.data?.gateways ?? []).map((gateway) => gateway.agent).filter((agent): agent is string => Boolean(agent)))].sort(), (id) => id);
  const inScope = (gatewayId: string) => !search.agent || agentOf(gatewayId) === search.agent;
  const senders = (access.data?.senders ?? []).filter((sender) => inScope(sender.gatewayId));
  const by = (status: string) => senders.filter((sender) => sender.status === status);
  const [pending, approved, denied, blocked] = [by("pending"), by("approved"), by("denied"), by("blocked")];
  // Everyone approved, where the page shows all agents' and was sent only the newest; else what it holds.
  const approvedTotal = !search.agent && !found ? Math.max(access.data?.approvedTotal ?? 0, approved.length) : approved.length;
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

          {/* The tabs, the agent and the filter stay at the top of the window while the list scrolls under them. */}
          <StickyBar
            label="Which senders"
            tools={
              <>
                <SearchInput value={query} onChange={setQuery} placeholder="Filter senders" className="w-48" />
                <SearchSelect
                  small
                  label="Agent"
                  options={[{ value: "", label: "All agents" }, ...agents.map((agent) => ({ value: agent, label: agent === orchestrator ? `♛ ${agent}` : agent }))]}
                  value={search.agent ?? ""}
                  onChange={(next) => onSearch({ ...search, agent: next || undefined })}
                  width={208}
                />
              </>
            }
          >
            <SegmentedTabs
              tabs={[
                { value: "pending", label: "Pending", after: count(pending.length, "badge-warning") },
                { value: "approved", label: "Approved", after: count(approvedTotal) },
                { value: "denied", label: "Denied", after: count(denied.length) },
                { value: "blocked", label: "Blocked", after: count(blocked.length) },
                { value: "history", label: "History" },
              ]}
              value={tab}
              onChange={(next) => onSearch({ ...search, tab: next })}
            />
          </StickyBar>

          <SenderQuery.Provider value={{ query, setQuery }}>
          {access.isPending ? (
            <ListLoading />
          ) : tab === "pending" ? (
            <PendingTab senders={pending} agentOf={agentOf} pairingOn={mode !== "allowlist"} />
          ) : tab === "approved" ? (
            <ApprovedTab senders={approved} allowlist={allowlist} blocked={blocked} agentOf={agentOf} total={approvedTotal} found={found} onFind={setFound} gateways={gateways.data?.gateways} />
          ) : tab === "denied" ? (
            <DeniedTab senders={denied} agentOf={agentOf} />
          ) : tab === "blocked" ? (
            <BlockedTab senders={blocked} agentOf={agentOf} />
          ) : (
            <HistoryTab senders={access.data?.senders ?? []} agentOf={agentOf} inScope={inScope} />
          )}
          </SenderQuery.Provider>
        </>
      )}
    </div>
  );
}
