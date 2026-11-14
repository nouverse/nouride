/**
 * "Your box", at the foot of the sidebar (0.8.24): whether the daemon is well, which version it runs, and an update
 * when one is ready, where the version used to sit small under the name. All of it is one way to the Update page,
 * a newer version out or not: it opened Settings unless one was, and a person who pressed the version to see what
 * there was to update landed on a list of everything else.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { badgeState, editionLabel, useUpdate } from "@/commons/hooks/use-update";
import { healthWarnings } from "@/commons/lib/health-warnings";
import { cn } from "@/commons/lib/utils";

export function BoxCard() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const update = useUpdate();
  const state = badgeState(update.data);
  const version = update.data?.install?.version ?? health.data?.version;
  const edition = update.data?.install?.edition ?? health.data?.edition;
  const warnings = health.data ? healthWarnings(health.data).length : 0;
  const well = health.data?.status === "ok" && warnings === 0;
  const pending = state === "available" || state === "downloading" || state === "ready";
  const words = !health.data ? "Connecting" : well ? "Running well" : health.data.status === "starting" ? "Starting" : warnings > 0 ? `${warnings} to look at` : "Not quite well";
  return (
    <Link to="/update" className="block space-y-2 rounded-[18px] border border-base-content/[0.08] bg-base-100 p-3 shadow-soft transition-colors hover:border-base-content/20">
      <span className="block space-y-1">
        <span className="block text-xs font-medium text-base-content/65">Your box</span>
        <span className="flex items-center gap-2 text-xs">
          <span className={cn("status size-2 shrink-0 rounded-full", !health.data ? "status-neutral" : well ? "status-success" : "status-warning")} aria-hidden="true" />
          <span className="font-medium">{words}</span>
        </span>
        {version && (
          <span className="block truncate font-mono text-xs text-base-content/65">
            v{version}
            {/* Which build, in the word a person uses for it — two boxes on this version can differ. */}
            {edition && edition !== "unknown" ? ` · ${editionLabel(edition)}` : ""}
          </span>
        )}
      </span>
      {pending && (
        <span className="btn btn-xs w-full border-0 bg-success/15 font-semibold text-success">
          {state === "ready" ? "Update ready to install" : `${update.data?.check?.latest ?? "A newer version"} is out`}
        </span>
      )}
    </Link>
  );
}
