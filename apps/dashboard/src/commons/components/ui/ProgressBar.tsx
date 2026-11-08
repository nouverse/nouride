/**
 * How far along something moving is (0.8.24): the mint bar easing into lavender of the design rules, on a track of the
 * hairline. Only where a real count is known (a mission's checklist): nothing is drawn as a guess.
 */

import { cn } from "@/commons/lib/utils";

export function ProgressBar({ done, total, label, className }: { done: number; total: number; label: string; className?: string }) {
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className={cn("h-2 w-full overflow-hidden rounded-full bg-base-content/[0.08]", className)}>
      <div className="bar-moving h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${share * 100}%` }} />
    </div>
  );
}
