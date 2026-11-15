/**
 * A search that is asked: a field, and a button that sends it (Enter does too). For what costs a request or a model's
 * time (a catalog, the documents), where `SearchInput` narrows a list already on the page as it is typed.
 *
 * Sized for the row that stays at the top of the window (`StickyTools`), where it takes what the tabs leave.
 */

import type { FormEvent, ReactNode } from "react";
import { Search } from "lucide-react";

export function SearchForm({
  value,
  onChange,
  onSearch,
  placeholder,
  label,
  busy = false,
  allowEmpty = false,
  after,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The words, trimmed, when the button is pressed. */
  onSearch: (words: string) => void;
  placeholder: string;
  /** For screen readers, and how a test finds the field. */
  label: string;
  busy?: boolean;
  /** Pressed with no words is a search too: back to the list before one. */
  allowEmpty?: boolean;
  /** After the button: a way to clear what was found, say. */
  after?: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const words = value.trim();
    if (words || allowEmpty) onSearch(words);
  };
  return (
    <form onSubmit={submit} role="search" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <label className="input input-sm flex min-w-0 flex-[1_1_12rem] items-center gap-2 rounded-xl">
        <Search size={14} className="shrink-0 opacity-50" aria-hidden="true" />
        <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent outline-none" aria-label={label} />
      </label>
      <button type="submit" className="btn btn-primary btn-sm rounded-xl gap-2" disabled={busy || (!allowEmpty && !value.trim())}>
        {busy ? <span className="loading loading-spinner loading-xs" /> : <Search size={14} aria-hidden="true" />} Search
      </button>
      {after}
    </form>
  );
}
