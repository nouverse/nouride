/**
 * A page's title that is written where it stands: it reads as the heading, and a press on it is the field. No dialog
 * and no pencil to find first; the heading says it can be changed when the pointer or the focus is on it.
 *
 * The field is as wide as its words (a hidden copy of them sizes it), so a short name is not a wide empty box. Enter
 * leaves it, Escape puts back what it held when it was entered. What it is called is not saved here: its page decides
 * when, as it does for every other field.
 */

import { useRef } from "react";
import { cn } from "@/commons/lib/utils";

export function InlineTitle({
  value,
  onChange,
  label,
  placeholder = "",
  readOnly = false,
  maxLength = 120,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  /** What the field is, for a screen reader: "Name". */
  label: string;
  placeholder?: string;
  /** Read as a heading and nothing more: for whoever may not change it. */
  readOnly?: boolean;
  maxLength?: number;
  className?: string;
}) {
  const entered = useRef(value);
  const heading = "text-2xl text-base-content sm:text-3xl";
  if (readOnly) return <h1 className={cn(heading, "[overflow-wrap:anywhere]", className)}>{value || placeholder}</h1>;
  return (
    <h1 className={cn(heading, "-mx-2 inline-grid max-w-full items-center", className)}>
      {/* The words once more, unseen, to give the field their width; a space keeps an empty one a line tall. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-2">
        {value || placeholder || " "}
      </span>
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        // The heading's own size on a phone too: the 16px every field takes there is for small text, which this is not.
        className="col-start-1 row-start-1 w-full min-w-0 rounded-[14px] bg-transparent px-2 font-display font-medium tracking-[-0.01em] outline-none transition-colors placeholder:text-base-content/65 hover:bg-base-content/[0.05] focus:bg-base-100 focus:ring-2 focus:ring-secondary/40 max-sm:text-2xl!"
        onFocus={() => {
          entered.current = value;
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            onChange(entered.current);
            event.currentTarget.blur();
          }
        }}
      />
    </h1>
  );
}
