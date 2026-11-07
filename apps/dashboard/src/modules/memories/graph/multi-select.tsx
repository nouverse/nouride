/**
 * A checklist in a dropdown — the graph's agent, person and tag filters, where any number can be
 * ticked. Ticking applies at once; the list stays open so several can be ticked in a row.
 *
 * What was ticked comes first when the list opens, so it can be unticked without a search. The order
 * is taken once per opening, not on every tick, so a row does not jump from under the pointer.
 */

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { offScreen, placeMenu } from "@/commons/lib/menu-place";

export interface Choice {
  value: string;
  label: string;
  count?: number;
}

/** Past this many choices the list gets a search box. */
const SEARCH_FROM = 8;

export function MultiSelect({
  label,
  none,
  icon,
  choices,
  selected,
  onChange,
}: {
  /** What it filters, for the screen reader and the search box. */
  label: string;
  /** The trigger when nothing is ticked: "All agents". */
  none: string;
  icon?: ReactNode;
  choices: readonly Choice[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [firstAtOpen, setFirstAtOpen] = useState<readonly string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const ticked = new Set(selected);

  // Drawn on the page, inside the window (`placeMenu`): 256 px tied to the button's left went off a phone's screen.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      if (offScreen(box, { height: window.innerHeight })) {
        setOpen(false);
        return;
      }
      setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width: 256, maxHeight: 340 }, "start") });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const toggleOpen = () => {
    if (!open) {
      setFirstAtOpen(selected);
      setQuery("");
    }
    setOpen(!open);
  };

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const first = new Set(firstAtOpen);
    // A ticked value no longer among the choices — a tag from an old link — is still shown, to untick.
    const known = new Set(choices.map((choice) => choice.value));
    const all: Choice[] = [...firstAtOpen.filter((value) => !known.has(value)).map((value) => ({ value, label: value })), ...choices];
    return all
      .filter((choice) => !words || choice.label.toLowerCase().includes(words))
      .sort((a, b) => Number(first.has(b.value)) - Number(first.has(a.value)));
  }, [choices, firstAtOpen, query]);

  const toggle = (value: string) => onChange(ticked.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  const labelOf = (value: string) => choices.find((choice) => choice.value === value)?.label ?? value;
  const summary = selected.length === 0 ? none : selected.length === 1 ? labelOf(selected[0]!) : `${labelOf(selected[0]!)} +${selected.length - 1}`;

  return (
    <div ref={root} className="relative" onKeyDown={(event) => {
      if (event.key !== "Escape" || !open) return;
      // Closes the list, and only that: the page's own Escape clears the graph's selection.
      event.stopPropagation();
      setOpen(false);
    }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        onClick={toggleOpen}
        className={`select select-sm bg-base-100 flex w-auto max-w-48 items-center gap-1.5 rounded-xl bg-none pr-2 ${selected.length ? "border-primary/50 text-base-content" : ""}`}
      >
        {icon}
        <span className="truncate">{summary}</span>
        {selected.length > 1 ? <span className="badge badge-primary badge-xs tabular-nums font-mono">{selected.length}</span> : null}
        <ChevronDown size={14} className={`ml-auto shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && place ? createPortal(
        <div ref={panel} style={place} className="border-base-content/[0.08] bg-base-100 z-[1000] flex flex-col overflow-hidden rounded-xl border shadow-lg">
          {choices.length > SEARCH_FROM ? (
            <label className="border-base-content/[0.06] flex items-center gap-2 border-b px-3 py-2">
              <Search size={13} className="opacity-50" />
              <input
                autoFocus
                className="w-full bg-transparent text-sm outline-none"
                placeholder={`Find ${label.toLowerCase()}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          <ul role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto p-1">
            {shown.map((choice) => {
              const on = ticked.has(choice.value);
              return (
                <li key={choice.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(choice.value)}
                    className="hover:bg-base-200/70 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors"
                  >
                    <span className={`grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors ${on ? "border-primary bg-primary text-primary-content" : "border-base-content/25"}`}>
                      {on ? <Check size={11} strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                    {choice.count !== undefined ? <span className="text-base-content/65 text-xs tabular-nums">{choice.count}</span> : null}
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="text-base-content/65 px-2 py-3 text-center text-xs">Nothing matches</li> : null}
          </ul>
          {selected.length ? (
            <div className="border-base-content/[0.06] flex items-center justify-between border-t px-3 py-1.5">
              <span className="text-base-content/65 text-xs tabular-nums">{selected.length} selected</span>
              <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={() => onChange([])}>
                <X size={12} /> Clear
              </button>
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
