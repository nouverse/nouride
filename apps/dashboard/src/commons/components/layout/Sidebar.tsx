/**
 * The whole menu with its names: beside every page from a laptop's width up, and More's sheet on a phone. Its head is
 * Nouride's name and version, its foot the box, who is signed in, the look and signing out. On Chats it can fold to its
 * icons (`CompactSidebar`), and its head offers that.
 */

import { Link } from "@tanstack/react-router";
import { LogOut, Moon, PanelLeftClose, Sun, X } from "lucide-react";
import type { Principal } from "@nouride/wire";
import { Mascot } from "@/commons/components/brand/Mascot";
import { BoxCard } from "@/commons/components/layout/BoxCard";
import { SidebarNav } from "@/commons/components/layout/nav";
import { SidebarVersion } from "@/commons/components/layout/SidebarVersion";
import type { Theme } from "@/commons/lib/theme";

export function Sidebar({
  pathname,
  where,
  principal,
  theme,
  toggleTheme,
  signOut,
  onClose,
  onFold,
}: {
  pathname: string;
  where: { admin: boolean; onBox: boolean; hostsGateway: boolean };
  principal: Principal | null | undefined;
  theme: Theme;
  toggleTheme: () => void;
  signOut: () => void;
  /** Closes More on a phone. */
  onClose: () => void;
  /** Folds the menu to its icons: offered on Chats only. */
  onFold?: () => void;
}) {
  const label = principal?.user?.displayName?.trim() ?? "";
  return (
    <div className="flex h-full w-full flex-col lg:w-64">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <Link to="/" className="group flex items-center gap-2.5">
          <Mascot pose="head" decorative className="w-9 transition-transform duration-150 group-active:scale-95" />
          <div className="leading-tight">
            <p className="font-display text-lg font-medium tracking-tight text-base-content">Nouride</p>
            <SidebarVersion />
          </div>
        </Link>
        {onFold ? (
          <button type="button" className="btn btn-ghost btn-square hidden size-10 text-base-content/70 hover:text-base-content lg:inline-flex" onClick={onFold} aria-label="Fold the menu to icons" title="Icons only">
            <PanelLeftClose size={18} />
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-square size-11 text-base-content/70 hover:text-base-content lg:hidden" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

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
          <button type="button" className="btn btn-ghost btn-square size-10 text-base-content/70 hover:bg-error/10 hover:text-error" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
