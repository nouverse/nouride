/**
 * An open agent's people at a glance, and the way to them: the Senders card's shape, for an agent nobody asks.
 *
 * Counts and a link, not the list: the list, its search, Read, Block and Unblock are on the Open agents page, where each
 * open agent's people are a list of their own. Each count opens that page on this agent. Who wrote is an admin's to
 * read, so the count of them is too; today's and the blocked are anyone's who sees the page.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Ban, CalendarDays, UsersRound } from "lucide-react";
import type { AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card } from "@/commons/components/ui/ui";

export function OpenPeople({ agent }: { agent: AgentSummary }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const name = agent.displayName || agent.id;
  const wrote = useQuery({ queryKey: ["agent-public", agent.id, "count"], queryFn: () => api.agentPublic(agent.id), enabled: admin, refetchInterval: 30_000 });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const access = useQuery({ queryKey: ["access"], queryFn: () => api.access(), refetchInterval: 15_000, retry: false });

  const mine = new Set((gateways.data?.gateways ?? []).filter((gateway) => gateway.agent === agent.id).map((gateway) => gateway.id));
  const blocked = (access.data?.senders ?? []).filter((sender) => sender.status === "blocked" && mine.has(sender.gatewayId)).length;
  const tiles = [
    ...(admin ? [{ key: "wrote", label: "Wrote to it", icon: UsersRound, n: wrote.data?.people, tone: "text-primary" }] : []),
    { key: "today", label: "Wrote today", icon: CalendarDays, n: agent.open?.today?.people, tone: "text-primary" },
    { key: "blocked", label: "Blocked", icon: Ban, n: access.data ? blocked : undefined, tone: "text-error" },
  ];

  return (
    <Card
      title="People who wrote"
      description={`Who wrote to ${name} while it is open, and who it keeps out. The list, with a search, Read and Block, is on Open agents.`}
      actions={
        <Link to="/open-agents" search={{ agent: agent.id }} className="btn btn-ghost btn-sm rounded-xl gap-1.5 text-primary">
          Open the list <ArrowRight size={14} aria-hidden="true" />
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-open-people>
        {tiles.map(({ key, label, icon: Icon, n, tone }) => (
          <Link
            key={key}
            to="/open-agents"
            search={{ agent: agent.id }}
            data-open-tile={key}
            className="rounded-xl border border-base-content/[0.08] bg-base-100 p-4 transition-all hover:border-primary/40 active:scale-[0.98]"
          >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-base-content/65">
              <Icon size={13} className={n ? tone : ""} aria-hidden="true" /> {label}
            </p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-base-content">{n === undefined ? "–" : n}</p>
          </Link>
        ))}
      </div>
    </Card>
  );
}
