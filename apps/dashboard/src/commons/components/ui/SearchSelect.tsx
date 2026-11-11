/**
 * A button that opens a list to pick one from, with a field at its top that narrows the list as it is typed into: for
 * a choice among more options than a row of tabs holds, such as each person in People. Its answer is always one of the
 * list, so it is not `Combobox`, whose typed text is an answer of its own.
 *
 * The list is drawn on `document.body`, fixed to the button (`placeMenu`), as `DropdownMenu`'s is: inside the chat
 * list's header it was cut off by the list below it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { placeMenu } from "@/commons/lib/menu-place";
import { cn } from "@/commons/lib/utils";

export interface SearchSelectOption<V extends string = string> {
  value: V;
  label: string;
}

export function SearchSelect<V extends string>({
  options,
  value,
  onChange,
  label,
  searchLabel,
  noMatch = (typed) => `Nothing called “${typed}”`,
  placeholder = "",
  width = 240,
  maxHeight = 320,
  align = "end",
  className,
}: {
  options: readonly SearchSelectOption<V>[];
  value: V;
  onChange: (next: V) => void;
  /** What is being picked: the list's name, and the button's with the option it holds ("Whose chats: Mine"). */
  label: string;
  /** The field's name and placeholder ("Find a person"). */
  searchLabel: string;
  /** The line shown when nothing in the list holds what was typed. */
  noMatch?: (typed: string) => string;
  /** The button's words while `value` is none of the options. */
  placeholder?: string;
  /** The list's width where the window has room for it, never narrower than the button. */
  width?: number;
  maxHeight?: number;
  /** Which edge of the button the list lines up with. */
  align?: "start" | "end";
  className?: string;
}) {
  const chosen = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const query = typed.trim().toLowerCase();
  const rows = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;

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
  }, [open, width, maxHeight, align]);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
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

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${chosen?.label ?? placeholder}`}
        className={cn("btn btn-ghost h-11 min-h-11 shrink-0 justify-between gap-1 rounded-xl border border-base-content/10 px-3 text-sm font-normal sm:h-10 sm:min-h-10", className)}
        onClick={() => {
          setTyped("");
          setActive(Math.max(0, options.findIndex((option) => option.value === value)));
          setOpen((was) => !was);
        }}
      >
        <span className="truncate">{chosen?.label ?? placeholder}</span>
        <ChevronDown size={15} aria-hidden="true" className={cn("shrink-0 text-base-content/65 transition-transform", open && "rotate-180")} />
      </button>
      {open && place
        ? createPortal(
            <div ref={panel} style={place} className="z-[1000] flex flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 p-1.5 shadow-xl">
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
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpen(false);
                    trigger.current?.focus();
                  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    if (rows.length > 0) setActive((at) => (at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
                  } else if (event.key === "Enter" && rows[active]) {
                    event.preventDefault();
                    pick(rows[active]);
                  }
                }}
              />
              <ul role="listbox" aria-label={label} className="min-h-0 list-none space-y-0.5 overflow-y-auto">
                {rows.length === 0 ? <li className="px-3 py-2 text-sm text-base-content/65">{noMatch(typed.trim())}</li> : null}
                {rows.map((option, index) => (
                  <li key={option.value} role="option" aria-selected={option.value === value}>
                    <button
                      type="button"
                      className={cn(
                        "flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm sm:min-h-9",
                        index === active ? "bg-base-200" : "hover:bg-base-200/60",
                        option.value === value && "font-medium text-primary",
                      )}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(option)}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
