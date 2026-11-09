/**
 * The side menu folded to its icons, on Chats from a laptop's width up: the list of chats and the conversation beside it
 * need the width the names took. Each page keeps its icon and a short name under it, and Expand gives the menu back —
 * a choice kept in this browser, so Chats opens the way it was left. Every other page keeps the whole menu, and a
 * phone keeps its tab bar.
 */

import { Link } from "@tanstack/react-router";
import { LogOut, Moon, PanelLeftOpen, Sun } from "lucide-react";
import { Mascot } from "@/commons/components/brand/Mascot";
import { SidebarNav } from "@/commons/components/layout/nav";
import type { Theme } from "@/commons/lib/theme";

/** The folded menu's buttons, the same tile as its links. */
const TILE = "flex w-16 flex-col items-center gap-1 rounded-[14px] py-2 text-[10px] font-medium text-base-content/70 transition-colors hover:bg-base-content/[0.05] hover:text-base-content outline-none focus-visible:ring-2 focus-visible:ring-secondary/60";

export function CompactSidebar({
  pathname,
  where,
  onExpand,
  theme,
  toggleTheme,
  signOut,
}: {
  pathname: string;
  where: { admin: boolean; onBox: boolean; hostsGateway: boolean };
  onExpand: () => void;
  theme: Theme;
  toggleTheme: () => void;
  signOut: () => void;
}) {
  return (
    <div className="flex h-full w-[5.5rem] flex-col items-center">
      <Link to="/" aria-label="Nouride home" className="mt-4 mb-1 grid size-11 shrink-0 place-items-center rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-secondary/60">
        <Mascot pose="head" decorative className="w-9" />
      </Link>
      <SidebarNav pathname={pathname} where={where} compact />
      <div className="flex shrink-0 flex-col items-center gap-0.5 pb-3">
        <button type="button" className={TILE} onClick={onExpand} aria-label="Expand the menu">
          <PanelLeftOpen size={18} aria-hidden="true" />
          <span aria-hidden="true">Expand</span>
        </button>
        <button type="button" className={TILE} onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to the day look" : "Switch to the night look"}>
          {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
          <span aria-hidden="true">{theme === "dark" ? "Day" : "Night"}</span>
        </button>
        <button type="button" className={TILE} onClick={signOut} aria-label="Sign out">
          <LogOut size={18} aria-hidden="true" />
          <span aria-hidden="true">Sign out</span>
        </button>
      </div>
    </div>
  );
}
