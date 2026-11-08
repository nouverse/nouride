/**
 * One sender, drawn the same way on every tab: the name they gave, the id that is actually them, the
 * platform and the agent whose connection they wrote to, and when — so moving between tabs never changes what a row
 * means. The name is whatever the platform reports, so the id under it is the part to trust.
 */

import { useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import type { SenderRecord } from "@nouride/wire";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { platformName } from "@/commons/lib/platform";

export function SenderLine({
  sender,
  agent,
  when,
  badge,
  actions,
  children,
}: {
  sender: Pick<SenderRecord, "gatewayId" | "senderId" | "senderName">;
  agent?: string | undefined;
  when?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  /** A second line under the row, the width of the list — the person picker, while it is open. */
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-bold text-sm text-base-content">
            {sender.senderName || <span className="text-base-content/65">Unnamed sender</span>}
          </p>
          {badge}
        </div>
        <p className="mt-1 flex min-w-0 items-center gap-2 text-xs">
          {/* The platform, from the connection's prefix — as People labels an id. */}
          <span className="badge badge-sm badge-ghost shrink-0 font-semibold font-mono">{platformName(sender.gatewayId)}</span>
          {agent ? <AgentBadge id={agent} /> : null}
          <span className="truncate font-mono text-base-content/65">
            {sender.gatewayId}:{sender.senderId}
          </span>
        </p>
        {when ? <p className="text-base-content/65 text-xs mt-0.5">{when}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      {children ? <div className="w-full">{children}</div> : null}
    </li>
  );
}

/**
 * Which agent's connection an account wrote to, as a badge rather than fine print — one colour for every
 * agent, so it reads as "the agent" at a glance without becoming a legend to learn.
 */
function AgentBadge({ id }: { id: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-secondary/30 bg-secondary/15 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-secondary"
      title={`Wrote to ${id}'s connection`}
    >
      <Bot size={11} /> {id}
    </span>
  );
}

/** Who gave an answer, as the audit log names them: a dashboard user, or the control token's `cli`. */
export const byWhom = (actor: string | null | undefined) => (actor ? ` by ${actor === "cli" ? "the server itself" : actor}` : "");

/** A button on a row. The three looks the old Access lists used, so a row reads as it did there. */
export const BUTTON = {
  primary: "btn btn-primary btn-xs rounded-lg gap-1 font-semibold shadow-xs active:scale-95 transition-all",
  plain: "btn btn-ghost btn-xs rounded-lg gap-1 font-semibold",
  danger: "btn btn-ghost btn-xs rounded-lg gap-1 text-error hover:bg-error/10 active:scale-95 transition-all",
} as const;

/**
 * The filter box every list on the page carries, as the Skills lists do: by the name they gave, their
 * id, or the agent whose connection they wrote to. Offered once a list has something to filter.
 */
export function useSenderFilter<T extends Pick<SenderRecord, "gatewayId" | "senderId" | "senderName">>(
  senders: readonly T[],
  agentOf: (gatewayId: string) => string | undefined,
  /** More to match on, where a list shows more — the person in People an account belongs to. */
  also: (sender: T) => (string | null | undefined)[] = () => [],
) {
  const [query, setQuery] = useState("");
  const visible = useTextFilter(senders, query, (sender) => [sender.senderName, `${sender.gatewayId}:${sender.senderId}`, agentOf(sender.gatewayId), ...also(sender)]);
  const search = senders.length > 0 ? { search: { value: query, onChange: setQuery, placeholder: "Filter senders" } } : {};
  return { visible, query, search };
}

export function NoMatch({ query }: { query: string }) {
  return <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{query}”.</p>;
}
