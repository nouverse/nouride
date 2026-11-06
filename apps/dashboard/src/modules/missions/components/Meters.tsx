/**
 * Four meters against their limits: the checklist's steps done, turns and the steps they took, hours worked and tokens. A limit reached stops
 * the mission to ask whether to go on, so a meter turns at the share the daemon warns the chat at — before, not at it.
 */

import type { Meter } from "../lib/mission";

export function Meters({ meters }: { meters: Meter[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" role="list" aria-label="Progress and limits">
      {meters.map((meter) => (
        <div
          key={meter.label}
          role="listitem"
          className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 p-3.5 shadow-xs backdrop-blur-xl"
        >
          <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">{meter.label}</p>
          <p className={`mt-1 text-sm font-semibold tabular-nums tracking-tight ${meter.near ? "text-warning" : "text-base-content"}`}>{meter.said}</p>
          {meter.bar === false ? null : (
            <progress
              className={`progress mt-2 h-1.5 w-full ${meter.near ? "progress-warning" : meter.label === "Checklist" ? "progress-primary" : ""}`}
              value={meter.share === null ? 0 : Math.round(meter.share * 100)}
              max={100}
              aria-label={`${meter.label}: ${meter.said}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
