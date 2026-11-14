/**
 * The way back to Settings from a page opened there (0.8.24, the owner on the box): a set-up page is reached through
 * Settings' cards, and on a phone its list is not in view, so each says where it came from and goes back in one tap.
 * Drawn by the shell over each of Settings' pages, as a section's tabs are over its pages.
 */

import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { SETTINGS, SETTINGS_HOME } from "@/commons/components/layout/nav";
import { cn } from "@/commons/lib/utils";

/** Settings' pages: every card it shows. */
const PAGES = new Set(SETTINGS.flatMap((group) => group.items.map((item) => item.to)));
/** The ones an admin does not reach from Settings: Logs and Update are tabs of System for them, in the menu itself. */
const NOT_AN_ADMINS = new Set(SETTINGS.flatMap((group) => group.items.filter((item) => item.exceptAdmin).map((item) => item.to)));

/** Whether `pathname` is one of Settings' own pages for this reader: the page itself, not one under it. */
export function fromSettings(pathname: string, admin = false): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return PAGES.has(path) && !(admin && NOT_AN_ADMINS.has(path));
}

export function SettingsBack({ pathname, admin, className }: { pathname: string; admin: boolean; className?: string }) {
  if (!fromSettings(pathname, admin)) return null;
  return (
    <Link to={SETTINGS_HOME} className={cn("btn btn-ghost btn-sm -ml-2 shrink-0 gap-1 self-start font-medium text-base-content/70 hover:text-base-content", className)}>
      <ChevronLeft size={16} aria-hidden="true" />
      Settings
    </Link>
  );
}
