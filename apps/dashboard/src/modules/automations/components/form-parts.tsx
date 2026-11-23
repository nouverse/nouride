/** The automation page's small form pieces: a card that is a radio button, a segmented switch, and the frame a pressed box's fields stand in. */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * A pressed box's fields as they are laid out: what they are of on top, the fields, and what ends them (Done, Delete).
 * Beside the canvas their card is as tall as the window has room for, and no taller: the head and the foot stay in
 * sight, and the fields scroll between them, to the card's own edges. In a box on a phone nothing holds its height,
 * and it is the three in a column.
 */
export function FieldsFrame({ head, foot, children, mark }: { head?: ReactNode; foot: ReactNode; children: ReactNode; /** What a test finds these fields by. */ mark: Record<`data-${string}`, string> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" {...mark}>
      {head ? <header className="shrink-0 pb-4">{head}</header> : null}
      <div data-fields-body className="min-h-0 flex-1 space-y-4 xl:-mx-5 xl:overflow-y-auto xl:overscroll-contain xl:px-5 xl:py-0.5 xl:[scrollbar-width:thin]">
        {children}
      </div>
      <div data-fields-foot className="mt-4 shrink-0 xl:-mx-5 xl:border-t xl:border-base-content/[0.08] xl:px-5 xl:pt-3.5">
        {foot}
      </div>
    </div>
  );
}

/** A card that is a radio button. Big enough to carry the sentence that makes the choice obvious. */
export function Choice({
  selected,
  label,
  hint,
  icon: Icon,
  disabled = false,
  onClick,
}: {
  selected: boolean;
  label: string;
  hint: string;
  icon?: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[18px] border p-3 text-left transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 ${
        selected ? "border-secondary/40 bg-secondary/10" : "border-base-content/10 bg-base-100 hover:border-base-content/20"
      }`}
    >
      <span className={`flex items-center gap-1.5 text-sm font-bold ${selected ? "text-secondary" : "text-base-content/85"}`}>
        {Icon && <Icon size={14} aria-hidden="true" />}
        {label}
      </span>
      <span className="mt-0.5 block text-xs leading-snug text-base-content/65">{hint}</span>
    </button>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" className="inline-flex max-w-full flex-wrap gap-0.5 rounded-full border border-base-content/10 bg-base-200 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all max-sm:min-h-8 ${
            value === option.value ? "bg-base-100 text-base-content shadow-xs" : "text-base-content/65 hover:text-base-content"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
