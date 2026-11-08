/**
 * Today's AI use and what it cost, folded to one line at the foot of Home (it was Overview's first card).
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins } from "lucide-react";
import { api } from "@/commons/lib/api";
import { EmptyState } from "@/commons/components/ui/ui";
import { CollapsibleCard } from "@/commons/components/ui/CollapsibleCard";
import { Details } from "@/commons/components/ui/Details";
import { UsageRoutes } from "./UsageRoutes";

/** 1,234,567 → "1.2M", 45,210 → "45.2K". */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Today's spend and token telemetry. */
export function UsageCard() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage(1), retry: false });
  const total = usage.data?.total;
  // Derived here rather than inline so the guard and the percentage cannot disagree about which
  // numbers they are talking about.
  const cacheActivity = (total?.cachedInputTokens ?? 0) + (total?.cacheCreationInputTokens ?? 0);
  const cachedShare =
    total && total.inputTokens > 0
      ? Math.round((total.cachedInputTokens / total.inputTokens) * 100)
      : 0;

  // Collapsed by default, at the top: today's token volume is the line worth a glance; the breakdown is not.
  return (
    <CollapsibleCard
      title="AI usage and spend"
      description="What your agents' AI use cost today, counted in tokens: the pieces of text a model reads and writes." // plain-words-ok: tokens, the unit a model's use is counted and billed in
      {...(total && total.requests > 0
        ? {
            // Tokens rather than dollars at a glance: the price depends on the model, the volume does not.
            summary: (
              <span className="font-mono text-xs text-base-content/70 sm:text-sm">
                <span className="font-semibold text-base-content">{COMPACT.format(total.inputTokens)}</span> in ·{" "}
                <span className="font-semibold text-base-content">{COMPACT.format(total.outputTokens)}</span> out ·{" "}
                <span className="font-semibold text-base-content">{cachedShare}%</span> cached
              </span>
            ),
          }
        : {})}
    >
      {!total || total.requests === 0 ? (
        <EmptyState icon={Coins} title="No model calls today" description="It shows here as soon as an agent answers." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-extrabold tracking-tight text-base-content sm:text-4xl">
              ${total.usd.toFixed(4)}
            </span>
            <span className="text-base-content/65 text-sm font-medium px-2.5 py-0.5 rounded-full bg-base-200 border border-base-content/10">
              {total.requests} {total.requests === 1 ? "call" : "calls"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Tokens read</p> {/* plain-words-ok: tokens, the unit a model's use is counted and billed in */}
              <p className="text-base font-bold font-mono text-base-content mt-0.5">{total.inputTokens.toLocaleString()}</p>
            </div>
            <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Tokens written</p> {/* plain-words-ok: tokens, the unit a model's use is counted and billed in */}
              <p className="text-base font-bold font-mono text-base-content mt-0.5">{total.outputTokens.toLocaleString()}</p>
            </div>
          </div>

          {/*
            * Cache activity, shown only when a provider reported some.
            *
            * `since()` sums with COALESCE, so a NULL — the provider said nothing — arrives here as 0
            * and is indistinguishable from "no hits". Absence of this line therefore means *nothing
            * was reported*, not that caching is off. Rendering a hard 0% would state the stronger of
            * the two, and the weaker one is the true one.
            */}
          {cacheActivity > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Cache Reads</p>
                <p className="text-base font-bold font-mono text-base-content mt-0.5">
                  {total.cachedInputTokens.toLocaleString()}
                  <span className="text-base-content/65 text-xs font-medium ml-1.5">{cachedShare}% of input</span>
                </p>
              </div>
              <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Cache Writes</p>
                <p className="text-base font-bold font-mono text-base-content mt-0.5">
                  {total.cacheCreationInputTokens.toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {/*
            * The one reading of these two numbers that is actionable.
            *
            * A write costs 25% *more* than an uncached token, so a breakpoint sitting after content
            * that changes every request writes a fresh entry each time and reads none of them back —
            * strictly worse than not caching. From the read count alone that is indistinguishable
            * from a cold start; it is the ratio that gives it away.
            */}
          {total.cacheCreationInputTokens > total.cachedInputTokens && (
            <div role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3">
              <AlertTriangle size={14} className="shrink-0" />
              <div className="space-y-1">
                <p>More was saved to the provider's cache than read back from it, and each save costs 25% more than not saving at all.</p>
                <Details>
                  <p>A cache breakpoint may sit after content that changes on every request. The cache boundary is described in docs/SPEC.md §6.3.</p>
                </Details>
              </div>
            </div>
          )}

          {total.unpricedRequests > 0 && (
            <div role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3">
              <AlertTriangle size={14} className="shrink-0" />
              <span>
                {total.unpricedRequests} calls have no known price, so the provider's bill may be higher than this total.
              </span>
            </div>
          )}

          <UsageRoutes days={usage.data?.routeDays ?? 7} routes={usage.data?.routes ?? []} warnings={usage.data?.cacheWarnings ?? []} />
        </div>
      )}
    </CollapsibleCard>
  );
}
