/**
 * What was asked and answered, newest first — from the audit log, because the lists show where each
 * person stands *now*: a revoke, a reset or an unblock removes them from every list, and an expired
 * request is gone by design. This is where "who let them in, and when" still has an answer.
 */

import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Ban, Check, Clock, RotateCcw, Unlock, UserPlus, UserX, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AccessEvent, SenderRecord } from "@nouride/wire";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { ago } from "@/commons/lib/format";
import { NoMatch, SenderLine, byWhom, useSenderFilter } from "./sender-line";
import { ListLoading } from "@/commons/components/ui/Spinner";

const SAID: Record<AccessEvent["action"], { icon: LucideIcon; tone: string; text: (event: AccessEvent) => string }> = {
  access_requested: { icon: UserPlus, tone: "text-info", text: () => "Asked to talk to the agent" },
  access_approved: { icon: Check, tone: "text-success", text: (event) => `Approved${byWhom(event.actor)}` },
  access_denied: {
    icon: X,
    tone: "text-error",
    text: (event) =>
      `Denied${byWhom(event.actor)}${event.details?.until ? `, could ask again from ${new Date(event.details.until).toLocaleString()}` : ""}`,
  },
  access_blocked: { icon: Ban, tone: "text-error", text: (event) => `Blocked${byWhom(event.actor)}` },
  access_revoked: { icon: UserX, tone: "text-warning", text: (event) => `Approval revoked${byWhom(event.actor)}` },
  access_reset: { icon: RotateCcw, tone: "text-info", text: (event) => `Denial reset${byWhom(event.actor)}, may ask again` },
  access_unblocked: { icon: Unlock, tone: "text-info", text: (event) => `Unblocked${byWhom(event.actor)}, may ask again` },
  access_expired: { icon: Clock, tone: "text-base-content/65", text: () => "The code expired, unanswered" },
};

export function HistoryTab({
  senders,
  agentOf,
  inScope,
}: {
  /** Where everybody stands now: the names for history lines older than names in the history. */
  senders: SenderRecord[];
  agentOf: (gatewayId: string) => string | undefined;
  inScope: (gatewayId: string) => boolean;
}) {
  const history = useQuery({ queryKey: ["access-history"], queryFn: api.accessHistory, refetchInterval: 30_000 });
  const entries = (history.data?.entries ?? []).filter((event) => event.gatewayId && inScope(event.gatewayId));

  // A request's sender is its actor; every answer names the sender in its details.
  const senderOf = (event: AccessEvent) => event.details?.sender ?? (event.action === "access_requested" ? event.actor : undefined);
  const names = new Map<string, string>();
  for (const sender of senders) if (sender.senderName) names.set(`${sender.gatewayId}:${sender.senderId}`, sender.senderName);
  for (const event of entries) {
    const name = event.details?.sender_name;
    if (name) names.set(`${event.gatewayId}:${senderOf(event)}`, name);
  }
  // Each line as a sender, so the one filter box reads them the way it reads every other list here.
  const lines = entries.map((event) => {
    const senderId = senderOf(event) ?? "?";
    return { event, gatewayId: event.gatewayId!, senderId, senderName: names.get(`${event.gatewayId}:${senderId}`) ?? null };
  });
  const { visible, query, search } = useSenderFilter(lines, agentOf);

  return (
    <ScrollCard title="History" description="Every request and every answer, newest first, kept as long as the audit log is." {...search}>
      <ErrorNote error={history.error} />
      {history.isPending ? (
        <ListLoading />
      ) : entries.length === 0 ? (
        <EmptyState pose="sleeping" title="Nothing yet" description="Requests and answers appear here as they happen." />
      ) : visible.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="divide-y divide-base-content/[0.08] -my-2">
          {visible.map(({ event, ...sender }, index) => {
            const said = SAID[event.action] ?? SAID.access_requested;
            const Icon = said.icon;
            return (
              <SenderLine
                key={`${event.timestamp}-${index}`}
                sender={sender}
                agent={agentOf(event.gatewayId!)}
                badge={<Icon size={14} className={said.tone} />}
                when={
                  <span title={new Date(event.timestamp).toLocaleString()}>
                    {said.text(event)} · {ago(event.timestamp)}
                  </span>
                }
              />
            );
          })}
        </ul>
      )}
    </ScrollCard>
  );
}
