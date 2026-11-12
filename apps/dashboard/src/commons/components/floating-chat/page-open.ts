/**
 * The page a message from the floating chat is written from (`OpenPage`), sent with it so the agent is told what the
 * person is looking at: its address as the browser shows it, what the dashboard calls it, and what it is about.
 *
 * What it is called is the page's own title where it has said one (`PageHeader` does, `use-page-subject.ts`), and else
 * the place the menu puts it in: a mission's page is in Missions, an agent's pages are in Agents.
 */

import type { OpenPage } from "@nouride/wire";
import { DAILY, SETTINGS, SETTINGS_HOME, isCurrent } from "@/commons/components/layout/nav";
import { sectionTabs } from "@/commons/components/layout/SectionTabs";
import { pageSaid } from "@/commons/hooks/use-page-subject";

/** What the menu calls the place a page is in: the nearest of a section's tabs at or over it, else its menu item. */
export function sectionTitle(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (let at = path; at.length > 1; at = at.slice(0, at.lastIndexOf("/"))) {
    const tab = sectionTabs(at)?.find((one) => one.to === at);
    if (tab) return tab.label;
  }
  if (path === SETTINGS_HOME) return "Settings";
  return [...DAILY, ...SETTINGS.flatMap((group) => group.items)].find((item) => isCurrent(item, path))?.label ?? "";
}

export function pageOpen(at: { basepath: string; pathname: string; search: string }): OpenPage {
  const said = pageSaid();
  return {
    path: `${at.basepath.replace(/\/+$/, "")}${at.pathname}${at.search}`,
    title: said.title ?? sectionTitle(at.pathname),
    ...(said.subject ? { subject: said.subject } : {}),
  };
}
