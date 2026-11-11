/**
 * What memory changed, and why — the People tab's first card.
 *
 * Facts are kept, rewritten and removed without asking (`[memory] facts = "auto"`), so this is how a
 * person checks: every change, newest first, with what it replaced and what caused it, and the
 * conversation it came from one click away. What someone said about a person who was not there is
 * marked: it is the kind of fact most worth a look. A wrong one is fixed in the profile's editor, which keeps
 * every version.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Link2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { ChangeCause, ChangeKind } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";

const KIND: Record<ChangeKind, { label: string; badge: string }> = {
  added: { label: "Added", badge: "badge-success" },
  updated: { label: "Updated", badge: "badge-info" },
  merged: { label: "Merged", badge: "badge-info" },
  removed: { label: "Removed", badge: "badge-warning" },
};

const CAUSE: Record<ChangeCause, string> = {
  pass: "nightly pass",
  consolidation: "profile tidy-up",
  agent: "an agent, in chat",
  approval: "approved by you",
};

export function RecentChanges({ nameOf, onOpenEpisode }: { nameOf: (key: string) => string; onOpenEpisode: (id: string) => void }) {
  const changes = useQuery({ queryKey: ["memory-changes"], queryFn: () => api.memoryChanges() });
  const list = changes.data?.changes ?? [];
  if (changes.error) return <ErrorNote error={changes.error} />;
  if (list.length === 0) return null;
  const today = list.filter((change) => Date.now() - change.at < 86_400_000).length;
  const secondhand = list.filter((change) => change.secondhand).length;

  return (
    <details className="group border-base-content/[0.08] bg-base-100/80 rounded-2xl border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-3.5">
        <span className="flex items-center gap-2">
          <ChevronDown size={14} className="text-base-content/50 transition-transform group-open:rotate-180" />
          <span className="font-semibold">Recent changes</span>
          <span className="text-base-content/65 text-xs">{today ? `${today} in the last day` : `${list.length} recently`}</span>
          {secondhand ? <span className="badge badge-ghost badge-xs font-mono">{secondhand} told by someone else</span> : null}
        </span>
      </summary>
      <ul className="border-base-content/[0.06] max-h-[50dvh] divide-y divide-base-content/[0.06] overflow-y-auto border-t px-5">
        {list.map((change, index) => (
          <li key={`${change.at}-${index}`} className="space-y-1 py-2.5">
            <p className="text-base-content/65 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className={`badge badge-xs ${KIND[change.change].badge}`}>{KIND[change.change].label}</span>
              <span className="text-base-content/80 font-medium">{change.subject === "shared" ? "Shared" : nameOf(change.subject)}</span>
              <span>{new Date(change.at).toLocaleString()}</span>
              <span>· {CAUSE[change.cause]}</span>
              {change.secondhand ? (
                <span className="badge badge-ghost badge-xs font-mono" title="Kept from a conversation they were not in">
                  told by someone else
                </span>
              ) : null}
              {change.source ? (
                <button type="button" className="link link-hover inline-flex items-center gap-0.5" onClick={() => onOpenEpisode(change.source!)}>
                  <Link2 size={11} /> from a conversation
                </button>
              ) : null}
            </p>
            <p className={`text-sm ${change.change === "removed" ? "text-base-content/65 line-through" : ""}`}>{change.text}</p>
            {change.previous ? (
              <p className="text-base-content/65 whitespace-pre-line text-xs">
                {change.change === "merged" ? "From:\n" : "Was: "}
                {change.previous}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
