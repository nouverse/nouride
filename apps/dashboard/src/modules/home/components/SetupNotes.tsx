/**
 * What the daemon said about how this install is set up when it last started — a secret every command is handed, an
 * agent with no credential, a WhatsApp number with no agent (`boot/advisories.ts` in the engine).
 *
 * Each is logged at warn the first time and at info after, so the journal stops repeating them — and without this
 * they were in the journal only. Folded away: these are things to fix when there is time, not things waiting on
 * somebody, which is what Home's needs-you cards are for. Renders nothing when the last boot said nothing.
 */

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "@/commons/lib/api";
import { CollapsibleCard } from "@/commons/components/ui/CollapsibleCard";
import { Details } from "@/commons/components/ui/Details";

export function SetupNotes() {
  // `retry: false`: a daemon older than the route answers 404, and that settles it.
  const notes = useQuery({ queryKey: ["advisories"], queryFn: api.advisories, staleTime: 60_000, retry: false });
  const lines = notes.data?.advisories ?? [];
  if (lines.length === 0) return null;

  return (
    <CollapsibleCard
      title="Setup notes"
      description="Things in how Nouride is set up for whoever runs this server to look at, found when it last started."
      summary={<span className="badge badge-sm badge-ghost font-mono">{lines.length}</span>}
    >
      <ul className="space-y-4">
        {lines.map((line) => (
          <li key={line.message} className="flex gap-3">
            <Info size={16} className="mt-0.5 shrink-0 text-info" aria-hidden="true" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm leading-snug text-base-content/90">{line.message}</p>
              {line.agents.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {line.agents.map((agent) => (
                    <span key={agent} className="badge badge-xs badge-ghost font-mono">
                      {agent}
                    </span>
                  ))}
                </div>
              )}
              {line.hint && (
                <Details>
                  <p>{line.hint}</p>
                </Details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </CollapsibleCard>
  );
}
