/**
 * "Saved (takes effect after a restart)", in place, with the Restart button beside it — for a page that knows from the
 * daemon that something saved is not in force yet: a connection added since the boot, web search's settings.
 */

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { RestartButton } from "@/commons/components/box/RestartButton";
import { RESTART_NEEDED } from "@/commons/hooks/use-saved";

export function RestartNeeded({ children }: { children?: ReactNode }) {
  return (
    <div role="status" className="alert flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
        <span>
          {RESTART_NEEDED}
          {children ? <span className="text-base-content/70 font-normal">: {children}</span> : null}
        </span>
      </span>
      <RestartButton className="btn-xs" />
    </div>
  );
}
