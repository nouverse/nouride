/**
 * Everyone's chats narrowed to one person, as an admin picks them: a field that lists People and finds a name as it is
 * typed. Its answer is always one of the list — every person, one person, or the private chats nobody in People is
 * known for — so it is not `Combobox`, whose typed text is an answer of its own.
 *
 * The list is drawn on `document.body`, fixed to the field (`placeMenu`), as the combobox's is: inside the chat list's
 * header it was cut off by the list below it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { placeMenu } from "@/commons/lib/menu-place";
import { cn } from "@/commons/lib/utils";
import type { WhoseOf } from "../hooks/use-whose";

interface Option {
  value: WhoseOf;
  label: string;
}

/** What the field offers: every person, each person in People by name, then nobody known. */
export function peopleOptions(people: readonly { key: string; name: string }[]): Option[] {
  return [
    { value: "", label: "All people" },
    ...[...people].sort((a, b) => a.name.localeCompare(b.name)).map((person) => ({ value: `person:${person.key}` as WhoseOf, label: person.name })),
    { value: "unknown", label: "Not known" },
  ];
}

export function PeopleFilter({ value, onChange }: { value: WhoseOf; onChange: (next: WhoseOf) => void }) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  const options = peopleOptions(people.data?.people ?? []);
  const chosen = options.find((option) => option.value === value) ?? options[0]!;
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const query = (typed ?? "").trim().toLowerCase();
  const rows = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = input.current?.getBoundingClientRect();
      if (box) setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width: box.width, maxHeight: 280 }, "start") });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped(null);
  };
  const pick = (option: Option) => {
    onChange(option.value);
    close();
    input.current?.blur();
  };

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (wrapper.current?.contains(target) || list.current?.contains(target))) return;
      close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  return (
    <div className="relative" ref={wrapper}>
      <input
        ref={input}
        role="combobox"
        aria-label="Whose chats, by person"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        className="input input-md h-11 w-full rounded-xl pr-16 text-sm sm:h-10"
        placeholder="Find a person"
        value={typed ?? (value ? chosen.label : "")}
        onFocus={() => {
          setTyped("");
          setActive(0);
          setOpen(true);
        }}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
            input.current?.blur();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (rows.length > 0) setActive((at) => (at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
          } else if (event.key === "Enter" && rows[active]) {
            event.preventDefault();
            pick(rows[active]);
          }
        }}
        onBlur={(event) => {
          if (!wrapper.current?.contains(event.relatedTarget) && !list.current?.contains(event.relatedTarget)) close();
        }}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
        {value ? (
          <button type="button" aria-label="All people" className="flex size-7 items-center justify-center rounded-lg text-base-content/65 hover:bg-base-200 hover:text-base-content" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(options[0]!)}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
        <ChevronDown size={15} aria-hidden="true" className={cn("mx-1.5 text-base-content/65 transition-transform", open && "rotate-180")} />
      </div>
      {open && place
        ? createPortal(
            <ul
              ref={list}
              role="listbox"
              aria-label="People"
              style={place}
              onMouseDown={(event) => event.preventDefault()}
              className="z-[1000] list-none space-y-0.5 overflow-y-auto rounded-2xl border border-base-content/10 bg-base-100 p-1.5 shadow-xl"
            >
              {rows.length === 0 ? <li className="px-3 py-2 text-sm text-base-content/65">Nobody called “{typed?.trim()}”</li> : null}
              {rows.map((option, index) => (
                <li key={option.value || "all"} role="option" aria-selected={option.value === value}>
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
