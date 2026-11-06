/**
 * This agent's senders at a glance, and the way to them.
 *
 * Counts and links, not the lists: those live on the Access page, one place for every agent, because a
 * person who asked two agents is one search there and two tabs here. Each count opens that page on its
 * tab, filtered to this agent.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Ban, Clock, Shield, ShieldOff, UserCheck } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState } from "@/commons/components/ui/ui";

export function AccessSummary({ agentId }: { agentId: string }) {
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const access = useQuery({ queryKey: ["access"], queryFn: api.access, refetchInterval: 15_000, retry: false });

  const mine = new Set((gateways.data?.gateways ?? []).filter((gateway) => gateway.agent === agentId).map((gateway) => gateway.id));
  if (gateways.data && mine.size === 0) {
    return (
      <Card>
        <EmptyState
          icon={Shield}
          title="No chat connections linked"
          description="Add a Telegram, Discord, or WhatsApp connection before managing who may talk to this agent."
        />
      </Card>
    );
  }

  const senders = (access.data?.senders ?? []).filter((sender) => mine.has(sender.gatewayId));
  const count = (status: string) => senders.filter((sender) => sender.status === status).length;
  const tiles = [
    { tab: "pending" as const, label: "Waiting", icon: Clock, n: count("pending"), tone: "text-warning" },
    { tab: "approved" as const, label: "Approved", icon: UserCheck, n: count("approved"), tone: "text-success" },
    { tab: "denied" as const, label: "Denied", icon: ShieldOff, n: count("denied"), tone: "text-error" },
    { tab: "blocked" as const, label: "Blocked", icon: Ban, n: count("blocked"), tone: "text-error" },
  ];

  return (
    <Card
      title="Senders"
      description={`Who has asked to talk to ${agentId}, and the answers. Approve, deny and block on the Access page.`}
      actions={
        <Link to="/access" search={{ agent: agentId }} className="btn btn-ghost btn-sm rounded-xl gap-1.5 text-primary">
          Open Access <ArrowRight size={14} />
        </Link>
      }
    >
      {access.error ? (
        <p className="text-base-content/65 text-sm">Access control is not turned on for this server.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map(({ tab, label, icon: Icon, n, tone }) => (
            <Link
              key={tab}
              to="/access"
              search={{ tab, agent: agentId }}
              className="rounded-xl border border-base-content/[0.08] bg-base-100 p-4 transition-all hover:border-primary/40 active:scale-[0.98]"
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-base-content/65">
                <Icon size={13} className={n > 0 ? tone : ""} /> {label}
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-base-content">{access.isPending ? "–" : n}</p>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
