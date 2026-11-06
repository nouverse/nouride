/**
 * "Nouride was updated" — for a tab whose code is older than the daemon it talks to (`commons/lib/bundle.ts`). A
 * reload, not a forced one: something typed in a form here would go with the page.
 */

import { RotateCw } from "lucide-react";

export function UpdatedBanner({ running }: { running: string }) {
  return (
    <div role="status" className="alert alert-info bg-info/10 text-info border-0 border-b border-info/20 rounded-none px-4 py-2 text-xs flex flex-wrap items-center gap-2 shrink-0">
      <span className="font-medium flex-1 min-w-0">Nouride was updated to {running}. This page is still the dashboard from before.</span>
      <button type="button" className="btn btn-info btn-xs gap-1" onClick={() => window.location.reload()}>
        <RotateCw size={12} aria-hidden="true" /> Reload
      </button>
    </div>
  );
}
