/** The automation page's small form pieces: a card that is a radio button, and a segmented switch. */

import type { LucideIcon } from "lucide-react";

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
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
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
