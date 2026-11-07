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
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, Loader2 } from "lucide-react";
import { placeMenu } from "@/commons/lib/menu-place";

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
  /** Words for an option, shown above it and searched with it — a chat id is a number, "DM · Gading" is a chat. */
  describe?: (option: string) => string | undefined;
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const rows = custom ? [custom, ...matches] : matches;

  /**
   * Where the list goes: under the field, or over it when the window has no room below.
   *
   * The list is drawn on `document.body`, fixed to the field's position, rather than inside it. Every
   * card here is `backdrop-blur`, and a blur makes a stacking context, so a list inside one card was
   * drawn *under* the next card whatever its z-index — the model picker on an agent's Model tab
   * opened behind the budget card below it.
   */
  const showing = open && rows.length > 0;
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

  const commit = (choice: string) => {
    onChange(choice);
    setDraft(null);
    setActive(-1);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        ref={inputRef}
        id={props.id}
        className={
          props.className ??
          "input w-full font-mono text-sm rounded-xl focus:ring-2 focus:ring-primary/20"
        }
        value={text}
        disabled={props.disabled}
        required={props.required}
        role="combobox"
        aria-expanded={open && rows.length > 0}
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
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (rows.length === 0) return;
            e.preventDefault();
            setOpen(true);
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
          setActive(-1);
          setOpen(false);
        }}
      />

      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Loader2 size={15} className="text-primary animate-spin" />
        </div>
      )}

      {showing && place && createPortal(
        <ul
          role="listbox"
          style={place}
          // The field keeps the focus while the list is scrolled or clicked, so its blur does not close it.
          onMouseDown={(e) => e.preventDefault()}
          className="bg-base-100/95 backdrop-blur-xl border border-base-content/10 z-[1000] list-none overflow-y-auto rounded-2xl p-1.5 shadow-xl space-y-0.5"
        >
          {rows.map((row, index) => {
            const isCustom = custom !== null && index === 0;
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
