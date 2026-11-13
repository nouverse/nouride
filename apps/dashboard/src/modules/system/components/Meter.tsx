/**
 * How full something is: a bar, and the words that say the same. The bar's colour turns at three quarters and at nine
 * tenths, and the words beside it say "getting full" and "nearly full" then, so the colour is never the only thing
 * that says it. With no figure there is no bar: an empty one would read as "nothing in use".
 */

import { cn } from "@/commons/lib/utils";
import { fullnessOf, type Fullness } from "../lib/words";

const TONE: Record<Fullness, { bar: string; words: string; label: string | null }> = {
  fine: { bar: "bg-success", words: "text-base-content/65", label: null },
  high: { bar: "bg-warning", words: "text-warning", label: "Getting full" },
  full: { bar: "bg-error", words: "text-error", label: "Nearly full" },
};

export function Meter({ share, label, words }: { share: number | null; label: string; words: string }) {
  const tone = share === null ? null : TONE[fullnessOf(share)];
  return (
    <div className="space-y-1.5">
      {share !== null && tone && (
        <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-valuetext={words} className="h-2.5 w-full overflow-hidden rounded-full bg-base-content/[0.08]">
          <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", tone.bar)} style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
        </div>
      )}
      <p className="text-sm text-base-content/85 [overflow-wrap:anywhere]">
        <span className="font-semibold">{words}</span>
        {tone?.label ? <span className={cn("ml-2 font-semibold", tone.words)}>{tone.label}</span> : null}
      </p>
    </div>
  );
}
