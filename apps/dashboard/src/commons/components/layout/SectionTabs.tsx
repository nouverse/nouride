/**
 * The pages one menu item holds, as tabs over each of them (0.8.24): Work's four, Memory's three, Agents' two and
 * System's three, which are an admin's but for Logs. Drawn
 * by the shell over a section's list pages, never over one mission or one agent, so each page keeps its own address
 * and a link to it still opens it.
 */

import { Link } from "@tanstack/react-router";
import { SEGMENTED_BAR } from "@/commons/components/ui/SegmentedTabs";
import { cn } from "@/commons/lib/utils";

interface Tab {
  to: string;
  label: string;
  /** A tab only an admin has: anyone else on the section's other page sees no bar of one tab. */
  adminOnly?: boolean;
}

const SECTIONS: Tab[][] = [
  [
    { to: "/work", label: "Waiting for you" },
    { to: "/automations", label: "Automations" },
    { to: "/missions", label: "Missions" },
    { to: "/jobs", label: "Helpers" },
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
  [
    { to: "/system", label: "System", adminOnly: true },
    { to: "/logs", label: "Logs" },
    { to: "/files", label: "Files", adminOnly: true },
  ],
];

/** A section's tab, in the menu's face rather than the mono of a page's own tabs: it is the menu, one level down. */
const tabClass = (current: boolean) =>
  cn(
    "flex shrink-0 items-center whitespace-nowrap rounded-xl px-3.5 py-2 text-sm transition-colors active:scale-95 sm:py-1.5",
    current ? "bg-secondary/10 font-semibold text-secondary" : "font-medium text-base-content/65 hover:bg-base-200/50 hover:text-base-content",
  );

/** The tabs over `pathname` for this reader, when it is one of a section's list pages and the section has more than it. */
export function sectionTabs(pathname: string, admin = true): Tab[] | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const tabs = SECTIONS.find((section) => section.some((tab) => tab.to === path))?.filter((tab) => admin || !tab.adminOnly);
  return tabs && tabs.length > 1 ? tabs : null;
}

export function SectionTabs({ pathname, admin, className }: { pathname: string; admin: boolean; className?: string }) {
  const tabs = sectionTabs(pathname, admin);
  if (!tabs) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    <div className={cn(SEGMENTED_BAR, "shrink-0 self-start", className)}>
      {tabs.map((tab) => (
        <Link key={tab.to} to={tab.to} aria-current={tab.to === path ? "page" : undefined} className={tabClass(tab.to === path)}>
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
