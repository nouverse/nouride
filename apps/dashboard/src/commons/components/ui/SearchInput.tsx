/**
 * A filter box: a search icon, the text, and a way to clear it. For narrowing a list already on the
 * page — not for asking the daemon anything, which is why it filters as you type and has no submit.
 */

import { Search, X } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  label,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** For screen readers; defaults to the placeholder. */
  label?: string;
  className?: string;
}) {
  return (
    <label className={cn("input input-sm flex items-center gap-2 rounded-xl", className)}>
      <Search size={14} className="shrink-0 opacity-50" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="min-w-0 flex-1 bg-transparent outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} className="shrink-0 text-base-content/65 hover:opacity-100" aria-label="Clear search">
          <X size={13} />
        </button>
      ) : null}
    </label>
  );
}
