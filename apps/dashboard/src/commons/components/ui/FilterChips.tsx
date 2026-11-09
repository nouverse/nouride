/**
 * A row of chips that narrows a list to one kind, each with how many there are: "All 9", "Discord 7", "Telegram 1".
 * One chip on at a time, said to a screen reader as pressed; the row wraps rather than running off a phone's edge.
 * Only the kinds the list holds are offered, so no chip ever leads to nothing.
 */

import { cn } from "@/commons/lib/utils";

export interface Chip<T extends string> {
  value: T;
  label: string;
  count: number;
}

export function FilterChips<T extends string>({ chips, value, onChange, label }: { chips: readonly Chip<T>[]; value: T; onChange: (next: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const on = chip.value === value;
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(chip.value)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-secondary/60 max-sm:min-h-11",
              on ? "border-secondary/30 bg-secondary/10 text-secondary" : "border-base-content/10 text-base-content/70 hover:bg-base-content/[0.04]",
            )}
          >
            <span>{chip.label}</span>
            <span className={cn("tabular-nums", on ? "text-secondary" : "text-base-content/65")}>{chip.count > 999 ? "999+" : chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}
