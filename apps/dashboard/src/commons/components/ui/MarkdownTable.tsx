/**
 * A table in markdown (`Markdown`): which lines are one, and how it is drawn.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { moreToTheSide } from "@/commons/lib/scroll-edges";

/** A row's cells, from its line. */
export function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const cleaned = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return cleaned.split("|").map((cell) => cell.trim());
}

/** The line under a table's head: dashes between its bars. */
export function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

/**
 * A table in the text: its first row is its head. `at` is its place among the blocks, for its cells' keys, and
 * `cell` draws a cell's words as the text around the table draws its own.
 *
 * Its columns are the agent's, so it cannot fold into rows as the dashboard's own tables do on a phone
 * (`fold-table.ts`): it scrolls sideways in its box, and a shade on the side that holds more says so. Below `sm` a
 * column keeps a reader's width rather than squeezing a word to a line.
 */
export function MarkdownTable({ rows, at, cell }: { rows: string[][]; at: number; cell: (text: string, key: string) => ReactNode[] }) {
  const headers = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  useEffect(() => {
    const scroller = box.current;
    if (!scroller) return;
    const measure = () => {
      const next = moreToTheSide(scroller.scrollLeft, scroller.scrollWidth, scroller.clientWidth);
      setMore((was) => (was.start === next.start && was.end === next.end ? was : next));
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      resized?.disconnect();
    };
  }, []);
  const shade = "pointer-events-none absolute inset-y-0 z-10 w-6 from-base-content/15 to-transparent transition-opacity";
  return (
    <div className="relative my-3 overflow-hidden rounded-2xl border border-base-content/10 shadow-2xs" data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
      <div ref={box} className="overflow-x-auto overscroll-x-contain">
        <table className="table table-sm w-full">
          {headers.length > 0 && (
            <thead>
              <tr className="border-b border-base-content/10 bg-base-200/50 text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
                {headers.map((h, i) => (
                  <th key={i} className="py-2.5 px-3 max-sm:min-w-28">
                    {cell(h, `th${at}-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-base-content/[0.06]">
            {bodyRows.map((row, rIdx) => (
              <tr key={rIdx} className="hover:bg-base-200/30 transition-colors">
                {row.map((words, cIdx) => (
                  <td key={cIdx} className="py-2 px-3 text-xs text-base-content/85 max-sm:min-w-28">
                    {cell(words, `td${at}-${rIdx}-${cIdx}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span aria-hidden="true" className={`${shade} left-0 bg-gradient-to-r ${more.start ? "opacity-100" : "opacity-0"}`} />
      <span aria-hidden="true" className={`${shade} right-0 bg-gradient-to-l ${more.end ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}
