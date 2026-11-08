/**
 * Whether the helper model is doing its work, beside the setting that chooses it.
 *
 * Live (2026-10-21) the model set for the nightly pass went away, and the pass and every compaction failed for hours
 * with nothing on this page to say so. The daemon counts what failed in the last 24 h from its own log
 * (`modules/llm/helper-trouble.ts`) and answers it on `/status` as `helpers` — what `nouride doctor` says, and the
 * Home's warnings without the provider's words. This reads that list rather than a copy of it, so the three cannot
 * disagree. The Memory menu is an operator's, and so are those words: `/status` is where they are said.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { HelperTrouble } from "@nouride/wire";
import { ago } from "@/commons/lib/format";

/** One trouble, as a person reads it: what failed, how often, when last and on which model. */
function troubleLine(trouble: HelperTrouble, now = Date.now()): string {
  const when = ago(trouble.at, now);
  if (trouble.job === "fallback") {
    return `${trouble.model} could not answer in ${trouble.count} hour(s) of the last 24, most recently ${when}; each agent's own model is standing in for it.`;
  }
  const what = trouble.job === "compaction" ? "Summarizing a long conversation failed" : "The nightly pass could not ask its model";
  return `${what} ${trouble.count} time(s) in the last 24 h, most recently ${when}, on ${trouble.model}.`;
}

export function HelperStatus() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  // Nothing until it is known: a daemon before 0.7.25 does not count, and "working" would be a guess.
  const helpers = status.data?.helpers;
  if (!helpers) return null;
  if (helpers.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-base-content/80">
        <CheckCircle2 size={14} className="text-success shrink-0" aria-hidden="true" />
        Working, nothing is failing.
      </p>
    );
  }
  return (
    <div role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3 items-start">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-2">
        <ul className="space-y-2">
          {helpers.map((trouble) => (
            <li key={trouble.job}>
              <span>{troubleLine(trouble)}</span>
              {trouble.last ? <span className="block font-mono opacity-80 break-words">{trouble.last}</span> : null}
            </li>
          ))}
        </ul>
        <p className="opacity-80">Each clears once its job works again or its model is no longer the one set, at the latest 24 hours after its last failure.</p>
      </div>
    </div>
  );
}
