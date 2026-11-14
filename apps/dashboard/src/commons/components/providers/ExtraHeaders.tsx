/**
 * "Extra headers", folded away under the key's field wherever a provider is added or changed: what a service asks for
 * beyond its key. Most ask for nothing, so it stays closed until it holds something, and it opens by itself when a
 * picked service fills it: a person should see what was put there for them.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ListPlus } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export function ExtraHeaders({ value, onChange, saved = false, className }: { value: string; onChange: (text: string) => void; /** A provider that is already saved: its lines may be names alone. */ saved?: boolean; className?: string }) {
  const count = value.split("\n").filter((line) => line.trim() !== "").length;
  const [open, setOpen] = useState(count > 0);
  useEffect(() => {
    if (count > 0) setOpen(true);
  }, [count]);

  return (
    <details className={cn("group rounded-xl border border-base-content/[0.08] bg-base-200/40 text-xs", className)} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex min-h-10 cursor-pointer select-none list-none items-center gap-2 px-3 font-medium text-base-content/80 hover:text-base-content [&::-webkit-details-marker]:hidden">
        <ListPlus size={14} className="shrink-0" aria-hidden="true" />
        Extra headers
        {count > 0 ? <span className="rounded-full bg-base-content/[0.06] px-2 py-0.5 text-[10px] font-semibold text-base-content/70">{count}</span> : null}
        <ChevronDown size={14} className="ml-auto shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-2 border-t border-base-content/[0.06] px-3 py-2.5">
        <textarea
          className="textarea w-full rounded-xl font-mono text-xs leading-relaxed"
          rows={Math.max(2, count + 1)}
          aria-label="Extra headers"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Name: value"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="leading-relaxed text-base-content/70">
          Only if your provider asks for them. One on each line, as Name: value. Where a provider wants an id for each conversation, write {"{session}"} as the value.
          {saved ? " A saved one shows its name only: leave its line as it is to keep it, or remove the line to drop it." : ""}
        </p>
      </div>
    </details>
  );
}
