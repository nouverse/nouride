/**
 * A table in markdown (`Markdown`): how it is drawn.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { moreToTheSide } from "@/commons/lib/scroll-edges";

/** To which side a column's words are set, as the line under the table's head says (`:--`, `:-:`, `--:`). */
type Side = "left" | "center" | "right" | null;
const SET: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right" };

/**
 * A table in the text: `head` its first row, `rows` the rest, each cell drawn already as the text around the table
 * draws its own words, and `align` the side each column's words are set to.
 *
 * Its columns are the agent's, so it cannot fold into rows as the dashboard's own tables do on a phone
 * (`fold-table.ts`): it scrolls sideways in its box, and a shade on the side that holds more says so. A column keeps a
 * reader's width at every size of window: a table of many columns scrolls rather than squeezing a word to a line.
 */
export function MarkdownTable({ head, rows, align }: { head: ReactNode[]; rows: ReactNode[][]; align: readonly Side[] }) {
  const side = (column: number) => SET[align[column] ?? ""] ?? "";
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
          {head.length > 0 && (
            <thead>
              <tr className="border-b border-base-content/10 bg-base-200/50 text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
                {head.map((words, column) => (
                  <th key={column} className={`min-w-28 py-2.5 px-3 ${side(column)}`.trimEnd()}>
                    {words}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-base-content/[0.06]">
            {rows.map((row, at) => (
              <tr key={at} className="hover:bg-base-200/30 transition-colors">
                {row.map((words, column) => (
                  <td key={column} className={`min-w-28 py-2 px-3 text-xs text-base-content/85 ${side(column)}`.trimEnd()}>
                    {words}
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
