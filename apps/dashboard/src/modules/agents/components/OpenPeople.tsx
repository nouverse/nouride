/**
 * An open agent's people at a glance, and the way to them: the Senders card's shape, for an agent nobody asks.
 *
 * Counts and a link, not the list: the list, its search, Read, Block and Unblock are on the Open agents page, where each
 * open agent's people are a list of their own. Each count opens that page on this agent. Its conversations are what
 * that list counts, one a row, an admin's to read as the list is; today's people, every stranger who reached it today,
 * and the blocked are anyone's who sees the page. Three measures, each named for what it counts, so one is never read
 * as another that disagrees with it.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Ban, CalendarDays, MessagesSquare } from "lucide-react";
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
  // Each opens the page on the tab it counts.
  const tiles = [
    ...(admin ? [{ key: "conversations", label: "Conversations", icon: MessagesSquare, n: wrote.data?.total, tone: "text-primary", tab: "wrote" as const }] : []),
    { key: "today", label: "Wrote today", icon: CalendarDays, n: agent.open?.today?.people, tone: "text-primary", tab: "wrote" as const },
    { key: "blocked", label: "Blocked", icon: Ban, n: access.data ? blocked : undefined, tone: "text-error", tab: "blocked" as const },
  ];

  return (
    <Card
      title="People who wrote"
      description={`Who wrote to ${name} while it is open, and who it keeps out. The lists, with Read, Block and Unblock, are on Open agents.`}
      actions={
        <Link to="/open-agents" search={{ agent: agent.id, tab: "wrote" }} className="btn btn-ghost btn-sm rounded-xl gap-1.5 text-primary">
          Open the list <ArrowRight size={14} aria-hidden="true" />
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-open-people>
        {tiles.map(({ key, label, icon: Icon, n, tone, tab }) => (
          <Link
            key={key}
            to="/open-agents"
            search={{ agent: agent.id, tab }}
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
