/**
 * "How to get an API key", folded away under the key's field wherever a provider is added: each service a person is
 * likely to mean, a link to the page where its key is made, whether using it is charged by use or is part of a plan,
 * and a button that fills the form with that service's address. Closed until asked for: most people who reach the
 * field already hold a key.
 */

import { ChevronDown, ExternalLink, KeyRound } from "lucide-react";
import { KEY_HINTS, type KeyHint } from "@/commons/lib/key-hints";
import { cn } from "@/commons/lib/utils";

const COST: Record<KeyHint["cost"], { label: string; look: string }> = {
  "per-use": { label: "Pay per use", look: "bg-base-content/[0.06] text-base-content/70" },
  included: { label: "In your plan", look: "bg-success/15 text-success" },
};

export function KeyHints({ onUse, className }: { /** Fill the form from a line: its name, how it is talked to, its address. */ onUse?: (hint: KeyHint) => void; className?: string }) {
  return (
    <details className={cn("group rounded-xl border border-base-content/[0.08] bg-base-200/40 text-xs", className)}>
      <summary className="flex min-h-10 cursor-pointer select-none list-none items-center gap-2 px-3 font-medium text-base-content/80 hover:text-base-content [&::-webkit-details-marker]:hidden">
        <KeyRound size={14} className="shrink-0" aria-hidden="true" />
        How to get an API key
        <ChevronDown size={14} className="ml-auto shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ul className="divide-y divide-base-content/[0.06] border-t border-base-content/[0.06]">
        {KEY_HINTS.map((hint) => (
          <li key={hint.id} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a href={hint.keyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                {hint.name}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", COST[hint.cost].look)}>{COST[hint.cost].label}</span>
              {onUse ? (
                <button type="button" className="btn btn-ghost btn-xs ml-auto rounded-lg font-semibold text-secondary" aria-label={`Use ${hint.name}`} onClick={() => onUse(hint)}>
                  Use it
                </button>
              ) : null}
            </div>
            <p className="leading-relaxed text-base-content/70 [overflow-wrap:anywhere]">{hint.words}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
