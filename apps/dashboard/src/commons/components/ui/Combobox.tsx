/**
 * A text field that suggests, rather than one that decides.
 *
 * Every model picker in here used to be its own copy of the same combobox, and every copy made the
 * same assumption: that the list it was given is the set of legal answers. It is not. The list comes
 * from whatever `/v1/models` a gateway happens to expose — llama.cpp serves one entry, a proxy serves
 * hundreds, an endpoint behind a firewall serves an error — while the model that actually works is
 * whatever the provider accepts. So typing `Hell` used to close the popover and leave the person
 * staring at a field with no way to tell whether it had registered anything at all.
 *
 * Here the typed text is always an option, and always the first one: `claude-opus-` sits above the
 * three models that contain it, so a prefix you mean to send verbatim and a prefix you are using to
 * search are both one keystroke from done. The value is propagated as it is typed — the field is the
 * answer, the list is a shortcut — which is why there is no "invalid model" state to get stuck in.
 *
 * A model's list comes once something is typed (or on the arrow keys), never on focus alone, and an emptied field shows
 * none. On a phone a list opened on focus was moved by the keyboard coming up and by every keystroke after, and the
 * owner picking a model in the setup wizard had it jump under their finger (2026-11-07). A field whose answer is picked
 * from what is listed, a chat or a stored secret's name, asks for `listOnFocus`: nobody knows a chat's id to type.
 * A model picked in a panel asks for `listOnPress`: the whole list when the field is pressed or emptied. A list that
 * waited for typing never showed a person what there was to pick from, and one on focus would cover the rest of a
 * panel that hands the field the focus as it opens.
 *
 * The chevron at the end opens the whole list, whatever the field holds. Typing filters by what is in the box, so a
 * field that already held a model offered only that model, and seeing the others meant deleting its name first. The
 * chevron does not take the focus, so on a phone the keyboard stays down and the list stays where it opened.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CornerDownLeft, Loader2 } from "lucide-react";
import { placeMenu } from "@/commons/lib/menu-place";
import { cn } from "@/commons/lib/utils";

export interface ComboboxProps {
  /** Suggestions. May be empty, stale, or wrong — see above. */
  options: string[];
  value: string;
  onChange: (value: string) => void;
  /** Suggestions are still being fetched. The field stays usable while they are. */
  loading?: boolean;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  /** Shown on the free-text row. Defaults to the neutral "use exactly what I typed". */
  customHint?: string;
  className?: string;
  id?: string;
  /** Words for an option, shown above it and searched with it — a chat id is a number, "DM · Sam" is a chat. */
  describe?: (option: string) => string | undefined;
  /** The whole list on focus, for a field answered by picking from it; a model's list waits for typing (see above). */
  listOnFocus?: boolean;
  /** The whole list when the field is pressed, and when it is emptied (see above). Not for a phone: the keyboard moves it. */
  listOnPress?: boolean;
  /**
   * A row was picked, the typed text's own row included: for a field that acts on a pick at once. `onChange` is told
   * every keystroke, and a field that saved on that would save every prefix on the way to a name.
   */
  onPick?: (value: string) => void;
}

export function Combobox(props: ComboboxProps) {
  const { options, value, onChange, loading = false } = props;

  /**
   * What is in the box while it is being edited, and `null` once it is not.
   *
   * Two states rather than one because `value` is also written from outside — the agent's saved model
   * arrives after the first render, a profile change replaces it — and a single state would either
   * ignore that or overwrite what somebody is halfway through typing.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** Which row Enter takes. -1 is "none", which is also what a fresh keystroke resets it to. */
  const [active, setActive] = useState(-1);
  /** The arrow keys asked for the whole list: the one way to see it with nothing typed. */
  const [browsing, setBrowsing] = useState(false);
  /** The chevron asked for every option: not filtered by what the box holds, until something is typed. */
  const [whole, setWhole] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);

  const text = draft ?? value;
  const query = text.trim();
  const lowered = query.toLowerCase();

  const matches = query
    ? options.filter((option) => option.toLowerCase().includes(lowered) || props.describe?.(option)?.toLowerCase().includes(lowered))
    : options;
  // Only when it would say something the list does not already say: an exact hit is the same string
  // twice, and one of them pretending to be custom.
  const custom = query && !options.some((option) => option.toLowerCase() === lowered) ? query : null;
  const rows = whole ? options : custom ? [custom, ...matches] : matches;

  /**
   * Where the list goes: under the field, or over it when the window has no room below.
   *
   * The list is drawn on `document.body`, fixed to the field's position, rather than inside it. Every
   * card here is `backdrop-blur`, and a blur makes a stacking context, so a list inside one card was
   * drawn *under* the next card whatever its z-index — the model picker on an agent's Model tab
   * opened behind the budget card below it.
   */
  const showing = open && rows.length > 0 && (query !== "" || browsing || whole);
  useLayoutEffect(() => {
    if (!showing) return;
    const measure = () => {
      const box = inputRef.current?.getBoundingClientRect();
      if (!box) return;
      // The field's own width, kept inside the window, flipped up when there is no room below (`placeMenu`).
      setPlace({ position: "fixed", ...placeMenu(box, { width: window.innerWidth, height: window.innerHeight }, { width: box.width, maxHeight: 240 }, "start") });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [showing]);

  // The whole list opens at the model the field holds: of hundreds, it was somewhere below the first rows.
  useLayoutEffect(() => {
    if (showing && whole && place) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [showing, whole, place]);

  const close = () => {
    setActive(-1);
    setOpen(false);
    setBrowsing(false);
    setWhole(false);
  };

  const commit = (choice: string) => {
    onChange(choice);
    props.onPick?.(choice);
    setDraft(null);
    close();
  };

  /**
   * A list the chevron opened while the field had no focus has no blur to close it, so a press anywhere else does.
   * The list is on `document.body`, outside the field's wrapper, so a press on the list is not "anywhere else".
   */
  useEffect(() => {
    if (!showing) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (wrapperRef.current?.contains(target) || listRef.current?.contains(target))) return;
      close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [showing]);

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        ref={inputRef}
        id={props.id}
        // Room at the end for the chevron, so a long model name does not run under it.
        className={cn(props.className ?? "input w-full font-mono text-sm rounded-xl focus:ring-2 focus:ring-primary/20", "pr-9")}
        value={text}
        disabled={props.disabled}
        required={props.required}
        role="combobox"
        aria-expanded={showing}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={
          props.placeholder ??
          (loading
            ? "Loading available models…"
            : options.length > 0
              ? "Search or type a model name…"
              : "e.g. gpt-4o, claude-opus-4-6")
        }
        onChange={(e) => {
          setDraft(e.target.value);
          // Free text is the answer, not a pending search: whoever reads `value` sees it immediately,
          // so Save is enabled for a model this list has never heard of.
          onChange(e.target.value);
          setActive(-1);
          setOpen(true);
          setBrowsing(false);
          setWhole(props.listOnPress === true && e.target.value.trim() === "");
        }}
        onClick={() => {
          if (!props.listOnPress) return;
          setActive(-1);
          setOpen(true);
          setWhole(true);
        }}
        onFocus={() => {
          if (!props.listOnFocus) return;
          setOpen(true);
          setBrowsing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // The list alone, where one is showing: a panel the field is in closes on Escape too, and both went at once.
            if (showing) e.stopPropagation();
            close();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (rows.length === 0) return;
            e.preventDefault();
            setOpen(true);
            setBrowsing(true);
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((index) => {
              const next = index + step;
              if (next < 0) return rows.length - 1;
              if (next >= rows.length) return 0;
              return next;
            });
            return;
          }
          if (e.key === "Enter") {
            // Enter on a highlighted row picks it. Enter on the raw text is left to the form — the
            // text is already the value, so there is nothing here to intercept.
            if (open && active >= 0 && active < rows.length) {
              e.preventDefault();
              commit(rows[active]!);
              return;
            }
            setOpen(false);
          }
        }}
        onBlur={(e) => {
          if (wrapperRef.current?.contains(e.relatedTarget)) return;
          setDraft(null);
          close();
        }}
      />

      {loading ? (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Loader2 size={15} className="text-primary animate-spin" />
        </div>
      ) : (
        <button
          type="button"
          // Out of the tab order: the arrow keys already open the list from the field.
          tabIndex={-1}
          aria-label={showing && whole ? "Hide the list" : "Show the whole list"}
          aria-expanded={showing && whole}
          disabled={props.disabled || options.length === 0}
          className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-base-content/65 transition-colors hover:bg-base-200 hover:text-base-content disabled:pointer-events-none disabled:opacity-40"
          // Not the field's focus: on a phone that brings the keyboard up, and the list moves with it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (showing && whole) {
              close();
              return;
            }
            setActive(-1);
            setOpen(true);
            setWhole(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <ChevronDown size={15} className={cn("transition-transform", showing && whole && "rotate-180")} />
        </button>
      )}

      {showing && place && createPortal(
        <ul
          ref={listRef}
          role="listbox"
          style={place}
          // The field keeps the focus while the list is scrolled or clicked, so its blur does not close it.
          onMouseDown={(e) => e.preventDefault()}
          className="bg-base-100 border border-base-content/10 z-[1000] list-none overflow-y-auto rounded-2xl p-1.5 shadow-xl space-y-0.5"
        >
          {rows.map((row, index) => {
            const isCustom = custom !== null && !whole && index === 0;
            const selected = row === value;
            return (
              <li key={isCustom ? `custom:${row}` : row} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left font-mono text-xs transition-colors ${
                    selected
                      ? "bg-primary text-primary-content font-semibold"
                      : index === active
                        ? "bg-base-200 text-base-content"
                        : "text-base-content/85 hover:bg-base-200"
                  }`}
                  // Keeps the focus in the input, so the blur above does not fire before the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(row)}
                >
                  {props.describe?.(row) && !isCustom ? (
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-sans font-medium">{props.describe(row)}</span>
                      <span className={`truncate text-[10px] ${selected ? "text-primary-content/75" : "text-base-content/65"}`}>{row}</span>
                    </span>
                  ) : (
                    <span className="truncate">{row}</span>
                  )}
                  {isCustom && (
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-sans font-semibold uppercase tracking-wide ${
                        selected ? "text-primary-content/80" : "text-base-content/65"
                      }`}
                    >
                      <CornerDownLeft size={11} />
                      {props.customHint ?? "use as typed"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </div>
  );
}
