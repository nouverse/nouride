/**
 * Open agents: the agents anyone may write to, one at a time, with who wrote to it and who it keeps out.
 *
 * Not on the Access page. Nobody asks an open agent for a code, so it has nobody waiting, approved or denied, and the
 * people who wrote to one are strangers to every other agent. So each open agent's people are a list of their own,
 * never put together with another's, another open agent's included: a picker of the open agents, with no "All". What it
 * used today and its two limits are above the list, since they are what its people cost; the limits are changed on its
 * own Access tab, where it was opened.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Globe } from "lucide-react";
import type { AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { reachedOn, todaySaid } from "@/commons/lib/open-agent";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { BlockedTab } from "./blocked.tab";
import { PeopleWhoWrote } from "./people-who-wrote";

/** Its two limits, as one sentence. */
export function limitsSaid(limits: NonNullable<NonNullable<AgentSummary["open"]>["limits"]>): string {
  const tokens = limits.maxDailyTokens.toLocaleString("en-US");
  const messages = limits.maxDailyMessagesPerPerson.toLocaleString("en-US");
  return `At most ${tokens} tokens a day, and ${messages} ${limits.maxDailyMessagesPerPerson === 1 ? "message" : "messages"} from one person a day.`; // plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it
}

/** Where it is reached, what it used today, and its limits: what its people cost, above the list of them. */
function Today({ agent }: { agent: AgentSummary }) {
  const open = agent.open;
  return (
    <Card
      title={agent.displayName || agent.id}
      description={open ? reachedOn(open.connections) : undefined}
      actions={
        <Link to="/agents/$agentId/access" params={{ agentId: agent.id }} className="btn btn-ghost btn-sm rounded-xl gap-1.5 text-primary">
          Its Access tab <ArrowRight size={14} aria-hidden="true" />
        </Link>
      }
    >
      <div className="space-y-1 text-sm" data-open-today>
        {open?.today && open.limits ? <p>{todaySaid(open.today, open.limits.maxDailyTokens)}</p> : null}
        {open?.limits ? <p className="text-base-content/65">{limitsSaid(open.limits)} They are changed on its Access tab.</p> : null}
      </div>
    </Card>
  );
}

export default function OpenAgentsPage({ agent: wanted, onAgent }: { agent: string | undefined; onAgent: (agent: string) => void }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const access = useQuery({ queryKey: ["access"], queryFn: () => api.access(), refetchInterval: 15_000, retry: false });
  const me = useMe();
  const admin = isAdmin(me.data ?? null);

  const open = (status.data?.agents ?? []).filter((one) => one.access === "open");
  const picked = open.find((one) => one.id === wanted) ?? open[0];
  // A link from before, to an agent that has been closed since: its people are back on the Access page.
  const closed = wanted !== undefined && status.data && !open.some((one) => one.id === wanted) ? wanted : null;
  const agentOf = (gatewayId: string) => gateways.data?.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
  const blocked = picked ? (access.data?.senders ?? []).filter((sender) => sender.status === "blocked" && agentOf(sender.gatewayId) === picked.id) : [];

  return (
    <div className="space-y-6 *:animate-fade">
      <PageHeader title="Open agents" description="The agents anyone may write to, with no code: who wrote to each, and who it keeps out. One agent at a time." />

      {closed ? (
        <p className="text-base-content/65 text-sm" data-open-closed>
          {closed} is not open to everyone now, so who writes to it is on the{" "}
          <Link to="/access" search={{ agent: closed }} className="link link-primary">
            Access page
          </Link>
          .
        </p>
      ) : null}

      {status.isPending ? (
        <ListLoading />
      ) : !picked ? (
        <Card>
          <EmptyState
            icon={Globe}
            title="No agent is open to everyone"
            description="An admin opens an agent to everyone on that agent's own Access tab. Until then, everyone who writes to your agents is on the Access page."
            action={
              <Link to="/agents" className="btn btn-sm rounded-xl">
                Your agents
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* One agent's people at a time: with a second open agent, the picker; never the two together. */}
          {open.length > 1 ? (
            <div className="flex min-w-0 items-center gap-2" data-open-picker>
              {/* Held to the page's width: a long agent name is cut in the button, never pushed past a phone's edge. */}
              <SearchSelect small named className="max-w-full" label="Agent" options={open.map((one) => ({ value: one.id, label: one.displayName || one.id }))} value={picked.id} onChange={onAgent} width={208} />
            </div>
          ) : null}
          <div key={picked.id} className="space-y-6">
            <Today agent={picked} />
            {admin ? (
              <PeopleWhoWrote agent={picked} />
            ) : (
              <Card title="People who wrote">
                <p className="text-base-content/65 text-sm">Only an admin reads who wrote to it, and what they said.</p>
              </Card>
            )}
            {access.data ? <BlockedTab senders={blocked} agentOf={agentOf} whileOpen /> : null}
          </div>
        </>
      )}
    </div>
  );
}
