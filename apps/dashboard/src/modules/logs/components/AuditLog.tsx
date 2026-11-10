/** Logs → Audit: one row per decision, with the actor who made it. */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { EmptyState } from "@/commons/components/ui/ui";
import { Panel } from "./Panel";
import { ListLoading } from "@/commons/components/ui/Spinner";

export function AuditLog() {
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.audit(300),
    refetchInterval: 10_000,
    retry: false,
  });
  const entries = audit.data?.entries ?? [];

  return (
    <Panel
      title="Audit trail"
      retention="audit"
      description="Every tool run, approval answer and config change, with who caused it. Kept far longer than the daemon log: this is the record of authority, not a scroll."
    >
      {audit.isPending ? (
        <ListLoading count={5} />
      ) : entries.length === 0 ? (
        <EmptyState pose="inspecting" title="Nothing recorded yet" />
      ) : (
        // A table from a tablet's width up. On a phone its five columns scrolled sideways inside the card, so there each
        // row is a block: when, the action, who and which agent on one line, the details the whole width under them.
        <div className="overflow-x-auto">
          <table className="table table-sm w-full max-sm:block">
            {/* Sticky, so the columns still have names four hundred rows down. */}
            <thead className="sticky top-0 z-10 bg-base-100/95 backdrop-blur-sm max-sm:hidden">
              <tr className="border-b border-base-content/[0.08] text-base-content/65 text-[11px] uppercase tracking-wider font-mono">
                <th className="pl-3">When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Agent</th>
                <th className="pr-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-content/[0.06] max-sm:block">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-base-200/40 transition-colors align-top max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-1 max-sm:px-2 max-sm:py-2">
                  <td className="pl-3 py-2 font-mono text-[10px] text-base-content/65 whitespace-nowrap max-sm:p-0">
                    {new Date(entry.timestamp).toLocaleString([], { hour12: false })}
                  </td>
                  <td className="py-2 max-sm:p-0">
                    <span className="badge badge-sm badge-ghost font-mono text-[10px]">
                      {entry.action}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-base-content/80 max-sm:p-0">{entry.actor}</td>
                  <td className="py-2 font-mono text-[10px] text-base-content/65 max-sm:p-0">
                    {entry.agentId ?? "—"}
                  </td>
                  <td className="pr-3 py-2 font-mono text-[10px] text-base-content/65 break-all max-w-md max-sm:max-w-none max-sm:basis-full max-sm:p-0">
                    {entry.details ? JSON.stringify(entry.details) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
