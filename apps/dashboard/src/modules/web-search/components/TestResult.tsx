/** What a test search found, or why it found nothing: in the page's words where the server gave them (0.8.20), its own under Details. */

import { CheckCircle2, XCircle } from "lucide-react";
import type { WebSearchTest } from "@nouride/wire";
import { Details } from "@/commons/components/ui/Details";

export function TestResult({ result }: { result: WebSearchTest }) {
  if (!result.ok) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-error/20 bg-error/5 p-3 text-xs text-error">
        <XCircle size={15} className="mt-0.5 shrink-0" />
        {result.plain ? (
          <div className="min-w-0 space-y-1">
            <span className="block break-words font-medium">{result.plain}</span>
            {result.error ? (
              <Details>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{result.error}</p>
              </Details>
            ) : null}
          </div>
        ) : (
          <span className="whitespace-pre-wrap break-words font-medium">{result.error ?? "The test search failed."}</span>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-success/20 bg-success/5 p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-success">
        <CheckCircle2 size={15} /> It works
        <span className="font-normal text-base-content/65">
          “{result.query}” answered in {((result.ms ?? 0) / 1000).toFixed(1)}s{result.source ? ` by ${result.source}` : ""}
        </span>
      </p>
      <ul className="space-y-1 pl-6">
        {(result.results ?? []).map((hit) => (
          <li key={hit.url} className="truncate text-xs">
            <span className="text-base-content/85">{hit.title}</span>{" "}
            <span className="font-mono text-base-content/65">{hit.url}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
