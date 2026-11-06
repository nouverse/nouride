/** The job form's building blocks: a titled section, a card that is a radio button, and a segmented switch. */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-base-content/[0.08] bg-base-200/30 p-3.5">
      <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">{title}</p>
      {children}
    </div>
  );
}

/** A card that is a radio button. Big enough to carry the sentence that makes the choice obvious. */
export function Choice({
  selected,
  label,
  hint,
  icon: Icon,
  onClick,
}: {
  selected: boolean;
  label: string;
  hint: string;
  icon?: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-2.5 rounded-xl border transition-all active:scale-[0.99] ${
        selected
          ? "border-primary/40 bg-primary/10 shadow-xs"
          : "border-base-content/10 bg-base-100 hover:border-base-content/20"
      }`}
    >
      <span
        className={`flex items-center gap-1.5 text-xs font-bold ${
          selected ? "text-primary" : "text-base-content/80"
        }`}
      >
        {Icon && <Icon size={13} />}
        {label}
      </span>
      <span className="block text-[11px] leading-snug text-base-content/65 mt-0.5">{hint}</span>
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
    <div className="inline-flex p-0.5 rounded-xl bg-base-200 border border-base-content/10">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
            value === option.value
              ? "bg-base-100 text-base-content shadow-xs"
              : "text-base-content/65 hover:text-base-content"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
