/** Logs → Audit: one row per decision, with the actor who made it. */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { EmptyState } from "@/commons/components/ui/ui";
import { Panel } from "./Panel";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { FOLD } from "@/commons/components/ui/fold-table";
import { cn } from "@/commons/lib/utils";

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
        // A table from a phone's width up; on a phone, by the one rule for tables (`FOLD`): when, the action, who and
        // which agent on one line, the details the whole width under them.
        <div className="overflow-x-auto">
          <table className={cn(FOLD.table, "table-sm")}>
            {/* Sticky, so the columns still have names four hundred rows down. */}
            <thead className={cn("sticky top-0 z-10 bg-base-100/95 backdrop-blur-sm", FOLD.head)}>
              <tr className="border-b border-base-content/[0.08] text-base-content/65 text-[11px] uppercase tracking-wider font-mono">
                <th className="pl-3">When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Agent</th>
                <th className="pr-3">Details</th>
              </tr>
            </thead>
            <tbody className={cn("divide-y divide-base-content/[0.06]", FOLD.body)}>
              {entries.map((entry) => (
                <tr key={entry.id} className={cn("hover:bg-base-200/40 transition-colors align-top", FOLD.row)}>
                  <td className={cn("pl-3 py-2 font-mono text-[10px] text-base-content/65 whitespace-nowrap", FOLD.cell)}>
                    {new Date(entry.timestamp).toLocaleString([], { hour12: false })}
                  </td>
                  <td className={cn("py-2", FOLD.cell)}>
                    <span className="badge badge-sm badge-ghost font-mono text-[10px]">
                      {entry.action}
                    </span>
                  </td>
                  <td className={cn("py-2 text-xs text-base-content/80", FOLD.cell)}>{entry.actor}</td>
                  <td className={cn("py-2 font-mono text-[10px] text-base-content/65", FOLD.cell)}>
                    {entry.agentId ?? "—"}
                  </td>
                  <td className={cn("pr-3 py-2 font-mono text-[10px] text-base-content/65 break-all max-w-md max-sm:max-w-none", FOLD.whole)}>
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
