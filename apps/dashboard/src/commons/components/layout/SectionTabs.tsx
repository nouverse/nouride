/**
 * The pages one menu item holds, as tabs over each of them (0.8.24): Work's four, Memory's three and Agents' two. Drawn
 * by the shell over a section's list pages, never over one mission or one agent, so each page keeps its own address
 * and a link to it still opens it.
 */

import { Link } from "@tanstack/react-router";
import { SEGMENTED_BAR } from "@/commons/components/ui/SegmentedTabs";
import { cn } from "@/commons/lib/utils";

interface Tab {
  to: string;
  label: string;
}

const SECTIONS: Tab[][] = [
  [
    { to: "/work", label: "Waiting for you" },
    { to: "/missions", label: "Missions" },
    { to: "/jobs", label: "Helpers" },
    { to: "/schedule", label: "Schedule" },
  ],
  [
    { to: "/memories", label: "Knowledge & Memory" },
    { to: "/people", label: "People" },
    { to: "/groups", label: "Groups" },
  ],
  [
    { to: "/agents", label: "Agents" },
    { to: "/office", label: "Office" },
  ],
];

/** A section's tab, in the menu's face rather than the mono of a page's own tabs: it is the menu, one level down. */
const tabClass = (current: boolean) =>
  cn(
    "flex shrink-0 items-center whitespace-nowrap rounded-xl px-3.5 py-2 text-sm transition-colors active:scale-95 sm:py-1.5",
    current ? "bg-secondary/10 font-semibold text-secondary" : "font-medium text-base-content/65 hover:bg-base-200/50 hover:text-base-content",
  );

/** The tabs over `pathname`, when it is one of a section's list pages. */
export function sectionTabs(pathname: string): Tab[] | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  return SECTIONS.find((tabs) => tabs.some((tab) => tab.to === path)) ?? null;
}

export function SectionTabs({ pathname }: { pathname: string }) {
  const tabs = sectionTabs(pathname);
  if (!tabs) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    <div className={`${SEGMENTED_BAR} shrink-0 self-start`}>
      {tabs.map((tab) => (
        <Link key={tab.to} to={tab.to} aria-current={tab.to === path ? "page" : undefined} className={tabClass(tab.to === path)}>
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
