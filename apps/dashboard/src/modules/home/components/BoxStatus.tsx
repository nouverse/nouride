/**
 * The box, at the foot of Home (0.8.24): what Overview's header said — the version, how long it has been up, whether
 * everything is working, an update and a restart — and the daemon's own warnings, which `/health` stays "ok" over.
 */

import { AlertTriangle } from "lucide-react";
import type { HealthPayload } from "@/commons/lib/api";
import { editionLabel } from "@/commons/hooks/use-update";
import { healthWarnings } from "@/commons/lib/health-warnings";
import { RestartButton } from "@/commons/components/box/RestartButton";
import { UpdateBadge } from "./UpdateBadge";

function uptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function BoxStatus({ health }: { health: HealthPayload }) {
  const warnings = healthWarnings(health);
  const state = health.status === "ok" ? "Everything is working" : health.status === "starting" && health.phase ? `Starting: ${health.phase}` : health.status === "starting" ? "Starting" : "Not everything is working";
  return (
    <section className="space-y-3">
      {warnings.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-[22px] border border-warning/30 bg-warning/10 p-4 text-warning">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">Something to look at</p>
            <ul className="list-inside list-disc space-y-0.5 text-sm">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <span className={`status size-2 rounded-full ${health.status === "ok" && warnings.length === 0 ? "status-success" : "status-warning"}`} aria-hidden="true" />
            {state}
          </p>
          <p className="text-xs text-base-content/65">
            <span className="font-mono">
              v{health.version}
              {health.edition && health.edition !== "unknown" ? ` · ${editionLabel(health.edition)}` : ""}
            </span>{" "}
            · Up for {uptime(health.uptime)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <UpdateBadge />
          <RestartButton />
        </div>
      </div>
    </section>
  );
}
