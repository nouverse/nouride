/**
 * A card for a list that can grow long: its header (title, description, a filter box when one is asked for) and the
 * list under it, shown to a height and then opened in full with one press.
 *
 * It scrolled inside itself. A list scrolling inside a card inside a page that scrolls is two things to scroll under
 * one finger, and the card's edge cut its rows where nobody could see an edge. A long list is now cut short with its
 * last rows fading out and a button that says how to see the rest; opened, it is as long as it is and the page scrolls.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/commons/lib/utils";
import { Card } from "./ui";
import { SearchInput } from "./SearchInput";

/**
 * What is inside, held to `maxHeight` until it is opened. The button is there only where the list is taller than
 * that: measured, and measured again when the list or the window changes.
 */
export function Expandable({ maxHeight = "max-h-[32rem]", className, children }: { maxHeight?: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // Taller than what shows: by a row's worth, so a list a few pixels over is simply shown.
    const measure = () => setLong((was) => (open ? was : element.scrollHeight > element.clientHeight + 24));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    for (const child of element.children) watch.observe(child);
    return () => watch.disconnect();
  }, [open, children]);
  return (
    <div className={className} data-expandable={open ? "open" : "closed"}>
      <div ref={box} className={cn("relative", !open && `${maxHeight} overflow-hidden`)}>
        {children}
        {long && !open ? <div className="from-base-100 pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t to-transparent" aria-hidden="true" /> : null}
      </div>
      {long ? (
        <div className="flex justify-center pt-2">
          <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-full" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            {open ? "Show less" : "Show all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ListCard({
  title,
  description,
  actions,
  search,
  maxHeight,
  className,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** A filter box in the header, beside any actions. */
  search?: { value: string; onChange: (next: string) => void; placeholder?: string };
  /**
   * For a list with another card under it: a Tailwind max-height class it is shown to before it is opened, written out
   * in full so the build sees it. Absent, the list is the page's own and is shown in full: the page scrolls.
   */
  maxHeight?: string;
  /** On the card itself: a border that says something is waiting, say. */
  className?: string;
  children: ReactNode;
}) {
  const header =
    search || actions ? (
      <div className="flex flex-wrap items-center gap-2">
        {search ? <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder} className="w-48" /> : null}
        {actions}
      </div>
    ) : undefined;
  return (
    <Card {...(title ? { title } : {})} {...(description ? { description } : {})} {...(header ? { actions: header } : {})} {...(className ? { className } : {})}>
      {maxHeight ? <Expandable maxHeight={maxHeight}>{children}</Expandable> : children}
    </Card>
  );
}
