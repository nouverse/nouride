/**
 * One person's part of a list an admin reads set apart by person (Automations, Missions): their name over what is
 * theirs, with how many. A region by the person's name, so a screen reader moves from person to person. Its words are
 * drawn as the lists' other small headings are ("Needs you", "Working") and are no heading of their own: the cards
 * under them are headed at the page's own level, which differs between the two pages.
 */

import type { ReactNode } from "react";

export function PersonSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={label} data-whose={label} className="space-y-2.5">
      <p className="px-1 font-mono text-[11px] font-bold uppercase tracking-wider text-base-content/65">
        {label} <span className="font-normal">· {count}</span>
      </p>
      {children}
    </section>
  );
}
