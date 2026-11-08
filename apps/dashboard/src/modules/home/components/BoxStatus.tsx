/**
 * The box on Home (0.8.24): what Overview's header said — the version, how long it has been up, whether everything is
 * working, an update and a restart — at the top, and the daemon's own warnings under the greeting.
 */

import { AlertTriangle } from "lucide-react";
import type { HealthPayload } from "@nouride/wire";
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

/** Whether the box is well, in words, from `/health` and its warnings. */
function stateOf(health: HealthPayload, warnings: number): { words: string; well: boolean } {
  if (health.status === "ok") return warnings === 0 ? { words: "Everything is working", well: true } : { words: "Working, with something to look at", well: false };
  if (health.status === "starting") return { words: health.phase ? `Starting: ${health.phase}` : "Starting", well: false };
  return { words: "Not everything is working", well: false };
}

/**
 * The box in one line, at the top of Home in the greeting's corner: whether
 * everything is working, the version and how long it has been up, the update badge and Restart.
 */
export function BoxLine({ health }: { health: HealthPayload }) {
  const state = stateOf(health, healthWarnings(health).length);
  return (
    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
      <span className="flex items-center gap-2 rounded-full border border-base-content/[0.08] bg-base-100/70 px-3 py-1.5 text-xs">
        <span className={`status size-2 rounded-full ${state.well ? "status-success" : "status-warning"}`} aria-hidden="true" />
        <span className="font-semibold text-base-content">{state.words}</span>
        <span className="text-base-content/65">
          <span className="font-mono">
            v{health.version}
            {health.edition && health.edition !== "unknown" ? ` · ${editionLabel(health.edition)}` : ""}
          </span>{" "}
          · Up for {uptime(health.uptime)}
        </span>
      </span>
      <UpdateBadge />
      <RestartButton />
    </div>
  );
}

/** The daemon's own warnings, which `/health` stays "ok" over: a card under the greeting, only while there are some. */
export function BoxWarnings({ health }: { health: HealthPayload }) {
  const warnings = healthWarnings(health);
  if (warnings.length === 0) return null;
  return (
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
  );
}
