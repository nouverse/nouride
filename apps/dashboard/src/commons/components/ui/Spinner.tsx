/**
 * Something is on its way. `Spinner` sits inside a button or a chip, in place of its icon, while that one thing is being
 * done. `ListLoading` stands where a list will be while it loads, drawn as the list's shape — rows, or cards side by
 * side — so a click or a tab never looks like nothing happened, and the page does not jump when the list comes. The
 * whole shape pulses as one, in opacity, and rests under the reduced-motion rule.
 */

import { cn } from "@/commons/lib/utils";

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`loading loading-spinner loading-xs ${className}`} aria-label="loading" />;
}

/** A card's or a row's lines while it loads: a title, and what is under it. */
function Lines({ under }: { under: number }) {
  return (
    <>
      <div className="h-3.5 w-1/3 rounded-full bg-base-content/10" />
      {Array.from({ length: under }, (_, at) => (
        <div key={at} className={cn("h-3 rounded-full bg-base-content/[0.07]", at === 0 ? "w-2/3" : "w-1/2")} />
      ))}
    </>
  );
}

export function ListLoading({ shape = "rows", count = 3 }: { shape?: "rows" | "cards"; count?: number }) {
  const drawn = Array.from({ length: count }, (_, at) => at);
  return (
    <div aria-busy="true" aria-label="loading" className={cn("animate-pulse", shape === "cards" ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" : "space-y-2.5")}>
      {drawn.map((at) =>
        shape === "cards" ? (
          <div key={at} className="flex h-40 flex-col gap-3 rounded-2xl border border-base-content/[0.06] p-5">
            <Lines under={2} />
          </div>
        ) : (
          <div key={at} className="space-y-2 rounded-2xl border border-base-content/[0.06] p-4">
            <Lines under={1} />
          </div>
        ),
      )}
    </div>
  );
}
