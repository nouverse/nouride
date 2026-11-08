/**
 * The one tab bar: a segmented control, the shape an agent's page, Memory, Skills and Logs all
 * use. It was four shapes — daisyUI `tabs-box` on two pages, two hand-rolled segmented bars of
 * different sizes on the others — so moving between pages changed what a tab looked like.
 *
 * `segmentClass` is exported for the one bar whose tabs are links (an agent's page, routed), so it
 * draws exactly what this draws.
 */

import { useEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * On a phone, one row that scrolls sideways: wrapped, four tabs left "Background jobs" alone on a second line under a
 * gap, and an agent's nine took three rows (0.8.12). The scrollbar is hidden there — the cut-off tab at the edge says
 * there is more — and each tab is a finger's height. From a tablet's width up it wraps, as it did.
 */
export const SEGMENTED_BAR =
  "inline-flex max-w-full flex-nowrap gap-0.5 overflow-x-auto overscroll-x-contain rounded-2xl border border-base-content/[0.08] bg-base-100 p-1 shadow-xs [scrollbar-width:none] sm:flex-wrap sm:[scrollbar-width:auto]";

export function segmentClass(active: boolean): string {
  return `flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 font-mono text-xs font-medium transition-all active:scale-95 sm:py-1.5 ${
    active ? "bg-secondary/10 font-semibold text-secondary" : "text-base-content/65 hover:bg-base-200/50 hover:text-base-content"
  }`;
}

/** The selected tab scrolled into the bar's view when it is chosen or the page opens on it — on a phone it can sit past the edge. */
export function useSelectedInView<T extends HTMLElement>(key: unknown) {
  const bar = useRef<T>(null);
  useEffect(() => {
    const box = bar.current;
    const selected = box?.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (!box || !selected || box.scrollWidth <= box.clientWidth) return;
    const [outer, inner] = [box.getBoundingClientRect(), selected.getBoundingClientRect()];
    box.scrollLeft += inner.left - outer.left - (outer.width - inner.width) / 2;
  }, [key]);
  return bar;
}

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** A count or a badge after the label. */
  after?: ReactNode;
  title?: string;
}

export function SegmentedTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly Segment<T>[]; value: T; onChange: (next: T) => void }) {
  const bar = useSelectedInView<HTMLDivElement>(value);
  return (
    <div ref={bar} role="tablist" className={SEGMENTED_BAR}>
      {tabs.map(({ value: tab, label, icon: Icon, after, title }) => (
        <button key={tab} type="button" role="tab" aria-selected={tab === value} title={title} className={segmentClass(tab === value)} onClick={() => onChange(tab)}>
          {Icon ? <Icon size={15} /> : null}
          <span>{label}</span>
          {after}
        </button>
      ))}
    </div>
  );
}

/** A tab's count, the one shape every tab bar uses — coloured only when it means somebody has to do something. */
export function Count({ n, highlight }: { n: number; highlight?: boolean }) {
  return <span className={`badge badge-xs font-mono ${highlight ? "badge-warning" : "badge-ghost"}`}>{n}</span>;
}
