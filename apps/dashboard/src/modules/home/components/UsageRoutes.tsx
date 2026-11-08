/**
 * Each route a model was reached through, and how much of its input came from the provider's cache (TOKEN_SAVINGS §3.1,
 * 0.8.13) — with, above it, a route of a model that caches far below another route of the same model, said with what
 * each costs. On the live box the same model cached 1 % one way and 94 % the other, and half the spend went the poor way.
 */

import { AlertTriangle } from "lucide-react";
import type { UsageRouteView } from "@nouride/wire";

export function UsageRoutes({ days, routes, warnings }: { days: number; routes: UsageRouteView[]; warnings: { said: string }[] }) {
  if (routes.length === 0) return null;
  return (
    <div className="space-y-2">
      {warnings.map((warning) => (
        <div key={warning.said} role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3">
          <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
          <span>{warning.said}</span>
        </div>
      ))}
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-base-content/65">By provider · last {days} days</p>
      <div className="overflow-x-auto rounded-xl border border-base-content/[0.06]">
        <table className="table table-xs font-mono">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th className="text-right">Calls</th>
              <th className="text-right">Cached</th>
              <th className="text-right">$ / M in</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={`${route.provider}|${route.model}`}>
                <td>{route.provider}</td>
                <td className="break-all">{route.model}</td>
                <td className="text-right">{route.requests.toLocaleString()}</td>
                {/* "—" where the provider said nothing of its cache: not a 0 %, which would be the stronger claim. */}
                <td className="text-right">{route.cachedShare === null ? "—" : `${Math.round(route.cachedShare * 100)}%`}</td>
                <td className="text-right">{route.usdPerMillion === null ? "—" : `$${route.usdPerMillion.toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
