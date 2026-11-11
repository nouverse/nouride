/**
 * A button that opens a list to pick one from: the dashboard's one dropdown. A long list (each person in People) has a
 * field at its top that narrows it as it is typed into; a short one (a list's filter, a step's next step) has none and
 * is picked with a press or the keys, which is `searchLabel` left out. Its answer is always one of the list, so it is
 * not `Combobox`, whose typed text is an answer of its own.
 *
 * The list is drawn on `document.body`, fixed to the button (`placeMenu`), as `DropdownMenu`'s is: inside the chat
 * list's header it was cut off by the list below it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { placeMenu } from "@/commons/lib/menu-place";
import { cn } from "@/commons/lib/utils";

export interface SearchSelectOption<V extends string = string> {
  value: V;
  label: string;
  /** A few characters at the row's far side: how many the choice holds, say. */
  detail?: string;
}

/** The row the keys move to from `at`, around the ends; a letter goes to the next row that starts with it. */
export function nextRow(labels: readonly string[], at: number, key: string): number {
  const count = labels.length;
  if (count === 0) return 0;
  if (key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowUp") return (at + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key.length !== 1 || key === " ") return at;
  const letter = key.toLowerCase();
  for (let step = 1; step <= count; step += 1) {
    const row = (at + step) % count;
    if (labels[row]!.toLowerCase().startsWith(letter)) return row;
  }
  return at;
}

/** The list itself: each option a row, the one the keys are on lit, the one it holds in the colour of where you are. */
function Rows<V extends string>({
  listRef,
  label,
  rows,
  value,
  active,
  short,
  none,
  onActive,
  onPick,
  onKey,
}: {
  listRef: RefObject<HTMLUListElement | null>;
  label: string;
  rows: readonly SearchSelectOption<V>[];
  value: V;
  active: number;
  /** No field over it: the list takes the focus and the keys, and its rows are reached by them, not by Tab. */
  short: boolean;
  none: string;
  onActive: (row: number) => void;
  onPick: (option: SearchSelectOption<V>) => void;
  onKey: (event: KeyboardEvent) => void;
}) {
  return (
    <ul ref={listRef} role="listbox" aria-label={label} tabIndex={short ? -1 : undefined} onKeyDown={short ? onKey : undefined} className="min-h-0 list-none space-y-0.5 overflow-y-auto outline-none">
      {rows.length === 0 ? <li className="px-3 py-2 text-sm text-base-content/65">{none}</li> : null}
      {rows.map((option, index) => (
        <li key={option.value} role="option" aria-selected={option.value === value}>
          <button
            type="button"
            tabIndex={short ? -1 : undefined}
            className={cn(
              "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm sm:min-h-9",
              index === active ? "bg-base-200" : "hover:bg-base-200/60",
              option.value === value && "font-medium text-secondary",
            )}
            onMouseEnter={() => onActive(index)}
            onClick={() => onPick(option)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.detail ? <span className="shrink-0 font-mono text-xs text-base-content/65">{option.detail}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Where the open list is drawn: fixed to its button, followed as the window is resized or anything under it scrolls. */
function usePlace(open: boolean, trigger: RefObject<HTMLButtonElement | null>, width: number, maxHeight: number, align: "start" | "end"): CSSProperties | null {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (box) setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width: Math.max(box.width, width), maxHeight }, align) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, trigger, width, maxHeight, align]);
  return place;
}

export function SearchSelect<V extends string>({
  options,
  value,
  onChange,
  label,
  searchLabel,
  named = false,
  noMatch = (typed) => `Nothing called “${typed}”`,
  placeholder = "",
  width = 240,
  maxHeight = 320,
  align = "end",
  small = false,
  disabled = false,
  className,
}: {
  options: readonly SearchSelectOption<V>[];
  value: V;
  onChange: (next: V) => void;
  /** What is being picked: the list's name, and the button's with the option it holds ("Whose chats: Mine"). */
  label: string;
  /** The field's name and placeholder ("Find a person"). Left out for a short list, which has no field. */
  searchLabel?: string;
  /** Whether the button says what is picked before the choice it holds ("Starts: All"), where nothing beside it does. */
  named?: boolean;
  /** The line shown when nothing in the list holds what was typed. */
  noMatch?: (typed: string) => string;
  /** The button's words while `value` is none of the options. */
  placeholder?: string;
  /** The list's width where the window has room for it, never narrower than the button. */
  width?: number;
  maxHeight?: number;
  /** Which edge of the button the list lines up with. */
  align?: "start" | "end";
  /** As tall as a small field from a tablet's width up, for a filter beside a list's search box; a finger's height on a phone. */
  small?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const chosen = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const place = usePlace(open, trigger, width, maxHeight, align);

  const query = typed.trim().toLowerCase();
  const rows = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;

  // The keys go to the field where there is one, and to the list itself where there is not. Once it is placed: the
  // list is not drawn before that, and a focus given to nothing left a short list deaf to the keys.
  const placed = place !== null;
  useEffect(() => {
    if (!open || !placed) return;
    (field.current ?? list.current)?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger.current?.contains(target) || panel.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const pick = (option: SearchSelectOption<V>) => {
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  /**
   * The keys of an open list. With no field (`short`), the list has them all: Home and End, a letter that goes to the
   * row it starts, Space that picks, and Tab that closes it and goes on from the button. A field keeps those for its text.
   */
  const keys = (event: KeyboardEvent, short: boolean) => {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "Escape" || (short && event.key === "Tab")) {
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "Enter" || (short && event.key === " ")) {
      event.preventDefault();
      if (rows[active]) pick(rows[active]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || (short && plain && (event.key === "Home" || event.key === "End" || event.key.length === 1))) {
      event.preventDefault();
      setActive((at) => nextRow(rows.map((row) => row.label), at, event.key));
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${chosen?.label ?? placeholder}`}
        disabled={disabled}
        className={cn("btn btn-ghost h-11 min-h-11 shrink-0 justify-between gap-1 rounded-xl border border-base-content/10 px-3 text-sm font-normal sm:h-10 sm:min-h-10", small && "sm:h-8 sm:min-h-8 sm:text-xs", className)}
        onClick={() => {
          setTyped("");
          setActive(Math.max(0, options.findIndex((option) => option.value === value)));
          setOpen((was) => !was);
        }}
      >
        <span className="truncate">
          {named ? <span className="text-base-content/65">{label}: </span> : null}
          <span className={named ? "font-semibold" : undefined}>{chosen?.label ?? placeholder}</span>
        </span>
        <ChevronDown size={15} aria-hidden="true" className={cn("shrink-0 text-base-content/65 transition-transform", open && "rotate-180")} />
      </button>
      {open && place
        ? createPortal(
            <div ref={panel} style={place} className="z-[1000] flex flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 p-1.5 shadow-xl animate-enter">
              {searchLabel ? (
                <input
                  ref={field}
                  aria-label={searchLabel}
                  role="combobox"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  autoComplete="off"
                  placeholder={searchLabel}
                  className="input input-sm mb-1 h-10 w-full shrink-0 rounded-xl text-base sm:text-sm"
                  value={typed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(event) => keys(event, false)}
                />
              ) : null}
              <Rows
                listRef={list}
                label={label}
                rows={rows}
                value={value}
                active={active}
                short={!searchLabel}
                none={noMatch(typed.trim())}
                onActive={setActive}
                onPick={pick}
                onKey={(event) => keys(event, true)}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
