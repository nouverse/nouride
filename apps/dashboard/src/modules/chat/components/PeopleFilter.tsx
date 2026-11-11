/**
 * Whose chats an admin reads, picked in one place: a button beside the search that opens a list to type into — Mine,
 * Everyone, each person in People by name, and the private chats nobody in People is known for. Its answer is always
 * one of the list, so it is not `Combobox`, whose typed text is an answer of its own.
 *
 * One control in the search's row: Mine and Everyone as a bar of their own, with a field for the person under it, were
 * three rows stacked above the list before anything in it showed.
 *
 * The list is drawn on `document.body`, fixed to the button (`placeMenu`), as the combobox's is: inside the chat list's
 * header it was cut off by the list below it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api } from "@/commons/lib/api";
import { placeMenu } from "@/commons/lib/menu-place";
import { cn } from "@/commons/lib/utils";
import type { Whose } from "../hooks/use-whose";

interface Option {
  value: Whose;
  label: string;
}

/** What the list offers: the reader's own first, everyone's, each person by name, then nobody known. */
export function peopleOptions(people: readonly { key: string; name: string }[]): Option[] {
  return [
    { value: "mine", label: "Mine" },
    { value: "everyone", label: "Everyone" },
    ...[...people].sort((a, b) => a.name.localeCompare(b.name)).map((person) => ({ value: `person:${person.key}` as Whose, label: person.name })),
    { value: "unknown", label: "Not known" },
  ];
}

export function PeopleFilter({ value, onChange, className }: { value: Whose; onChange: (next: Whose) => void; className?: string }) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  const options = peopleOptions(people.data?.people ?? []);
  const chosen = options.find((option) => option.value === value) ?? options[0]!;
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
      if (box) setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width: Math.max(box.width, 240), maxHeight: 320 }, "end") });
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
    field.current?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger.current?.contains(target) || panel.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const pick = (option: Option) => {
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
        aria-label={`Whose chats: ${chosen.label}`}
        className={cn("btn btn-ghost h-11 min-h-11 max-w-[9.5rem] shrink-0 justify-between gap-1 rounded-xl border border-base-content/10 px-3 text-sm font-normal sm:h-10 sm:min-h-10", className)}
        onClick={() => {
          setTyped("");
          setActive(Math.max(0, options.findIndex((option) => option.value === value)));
          setOpen((was) => !was);
        }}
      >
        <span className="truncate">{chosen.label}</span>
        <ChevronDown size={15} aria-hidden="true" className={cn("shrink-0 text-base-content/65 transition-transform", open && "rotate-180")} />
      </button>
      {open && place
        ? createPortal(
            <div ref={panel} style={place} className="z-[1000] flex flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 p-1.5 shadow-xl">
              <input
                ref={field}
                aria-label="Find a person"
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                autoComplete="off"
                placeholder="Find a person"
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
              <ul role="listbox" aria-label="Whose chats" className="min-h-0 list-none space-y-0.5 overflow-y-auto">
                {rows.length === 0 ? <li className="px-3 py-2 text-sm text-base-content/65">Nobody called “{typed.trim()}”</li> : null}
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
