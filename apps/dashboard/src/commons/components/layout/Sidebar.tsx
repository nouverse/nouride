/**
 * The whole menu with its names: beside every page from a laptop's width up, and More's sheet on a phone. Its head is
 * Nouride's name and version, its foot the box, who is signed in, the look and signing out. On Chats it can fold to its
 * icons (`CompactSidebar`), and its head offers that. Inside Nouride Home its last row closes the dashboard: the back
 * gesture walks the dashboard's history, and after a while of moving about it took as many presses to leave.
 */

import { Link } from "@tanstack/react-router";
import { ChevronLeft, LogOut, Moon, PanelLeftClose, Sun } from "lucide-react";
import type { Principal } from "@nouride/wire";
import { Mascot } from "@/commons/components/brand/Mascot";
import { BoxCard } from "@/commons/components/layout/BoxCard";
import { SidebarNav } from "@/commons/components/layout/nav";
import { SidebarVersion } from "@/commons/components/layout/SidebarVersion";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";
import type { Theme } from "@/commons/lib/theme";

/** Nouride's name, its head and its version: the sidebar's head, and the head of More's sheet. */
export function SidebarBrand() {
  return (
    <Link to="/" className="group flex items-center gap-2.5">
      <Mascot pose="head" decorative className="w-9 transition-transform duration-150 group-active:scale-95" />
      <div className="leading-tight">
        <p className="font-display text-lg font-medium tracking-tight text-base-content">Nouride</p>
        <SidebarVersion />
      </div>
    </Link>
  );
}

export function Sidebar({
  pathname,
  where,
  principal,
  theme,
  toggleTheme,
  signOut,
  inSheet = false,
  onFold,
}: {
  pathname: string;
  where: { admin: boolean; onBox: boolean; hostsGateway: boolean };
  principal: Principal | null | undefined;
  theme: Theme;
  toggleTheme: () => void;
  /** Absent in a device's session (`Principal.device`): no Sign out is drawn, and nothing in its place. */
  signOut?: (() => void) | undefined;
  /** Drawn in More's sheet on a phone, under the sheet's head. */
  inSheet?: boolean;
  /** Folds the menu to its icons: offered on Chats only. */
  onFold?: () => void;
}) {
  const label = principal?.user?.displayName?.trim() ?? "";
  return (
    <div className="flex h-full w-full flex-col lg:w-64">
      {/* In More's sheet, the sheet's own head carries the name and the close (`Sheet`). */}
      {inSheet ? null : (
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <SidebarBrand />
          {onFold ? (
            <button type="button" className="btn btn-ghost btn-square size-10 text-base-content/70 hover:text-base-content" onClick={onFold} aria-label="Fold the menu to icons" title="Icons only">
              <PanelLeftClose size={18} />
            </button>
          ) : null}
        </div>
      )}
      <SidebarNav pathname={pathname} where={where} />

      <div className="shrink-0 space-y-2 p-3">
        <BoxCard />
        <div className="flex items-center gap-2 px-1">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary/10 text-xs font-bold text-secondary">
            {(label || principal?.actor || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-xs font-semibold text-base-content">{label || principal?.actor}</p>
            <p className="text-xs font-medium capitalize text-base-content/65">{principal?.role}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-square size-10 text-base-content/70 hover:text-base-content" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to the day look" : "Switch to the night look"} title={theme === "dark" ? "Day look" : "Night look"}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {signOut ? (
            <button type="button" className="btn btn-ghost btn-square size-10 text-base-content/70 hover:bg-error/10 hover:text-error" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut size={16} />
            </button>
          ) : null}
        </div>
        {inHomeApp() && (
          <a href={HOME_APP_BACK} className="btn btn-ghost h-10 min-h-10 w-full justify-start gap-2 px-2 text-sm font-medium text-base-content/70 hover:text-base-content">
            <ChevronLeft size={18} aria-hidden="true" />
            Back to Nouride Home
          </a>
        )}
      </div>
    </div>
  );
}
