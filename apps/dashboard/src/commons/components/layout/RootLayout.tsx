/**
 * The shell every signed-in page renders inside.
 * Crafted with Apple Human Interface Guidelines:
 * - Translucent blurred sidebar
 * - Tactile active states and refined navigation indicators
 * - Clean typography and metadata capsules
 */

import { Link, Outlet, useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Box,
  Bot,
  BookOpen,
  Brain,
  Cat,
  Clock,
  Cpu,
  ExternalLink,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plug,
  Blocks,
  Radio as RadioIcon,
  Sparkles,
  Target,
  Sun,
  UserCog,
  Users,
  MessagesSquare,
  ScrollText,
  Search,
  ShieldCheck,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { api } from "@/commons/lib/api";
import { ReconnectingBanner, ReconnectingScreen, RestartedToast, RestartPendingBar } from "./Reconnecting";
import { UpdatedBanner } from "./UpdatedBanner";
import { bundleVersion, staleBundle } from "@/commons/lib/bundle";
import { isAdmin, MCP_LOGIN_CALLBACK, useGate } from "@/commons/lib/session";
import { useTheme } from "@/commons/lib/theme";
import { NougateGlyph, NovaAppIcon } from "@/commons/components/icons/logos";
import { SidebarVersion } from "@/commons/components/layout/SidebarVersion";
import { useSignOut } from "@/commons/components/layout/sign-out";
import { PendingAccessBadge } from "@/commons/components/layout/PendingAccessBadge";
import { gatewayDashboard } from "@/commons/lib/bundled-gateway";
import { isPairedBox } from "@/commons/lib/api.appliance";
import { DOCS_URL } from "@/commons/lib/docs";
import { PAGE_BOTTOM } from "@/commons/components/ui/ScrollCard";

interface NavItem {
  /** An in-app route. Exactly one of `to` and `href` is set. */
  to?: string;
  /**
   * A full URL, opened in a new tab.
   *
   * Separate from `to` because the router would try to resolve an absolute URL as one of its own
   * routes and land on the 404 — and because leaving the dashboard mid-task is something a person
   * should be able to undo by closing a tab, not by losing what they were doing.
   */
  href?: string;
  label: string;
  /** A Lucide icon, or anything drawn the same way — `NougateGlyph` takes `size` like one. */
  icon: LucideIcon | ComponentType<{ size?: number; className?: string }>;
  adminOnly?: boolean;
  /**
   * Shown only on a paired Box. My Box is served by the appliance plugin, which is active only on a
   * box it was flashed onto — the same Pro edition in a pod has nothing behind the page.
   */
  boxOnly?: boolean;
  /**
   * Shown only where this daemon hosts the LLM gateway and serves its dashboard (`router` or
   * `pro`, with `[nougate] in_process`), and only once the dashboard bundle beside the binary
   * can be shown in a frame — `gatewayDashboard` has why.
   */
  gatewayOnly?: boolean;
  /** Something waiting there, drawn after the label — and nothing when nothing is. */
  badge?: ComponentType;
}


const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Interact",
    items: [
      { to: "/chat", label: "Chat", icon: MessageSquare },
      // Beside Chat: work an agent was handed in a chat and finishes alone, reporting back to it (0.8.0).
      { to: "/missions", label: "Missions", icon: Target },
    ],
  },
  {
    group: "Monitor",
    items: [
      { to: "/", label: "Overview", icon: RadioIcon },
      // Under Overview: the same statuses, as a small office of cats — for watching, not for settings (0.8.1).
      { to: "/office", label: "Office", icon: Cat },
      { to: "/schedule", label: "Schedule", icon: Clock },
      // Next to Schedule because they are the same thing seen from the two sides that matter: what
      // fires on a clock, and what fires when something calls it.
      { to: "/webhooks", label: "Webhooks", icon: Webhook },
      // After them (0.8.12): the third kind of work that runs without anyone in the chat — helpers, commands and asks an
      // agent left in the background, each opening to its steps; before, only `nouride jobs log` on the box showed them.
      // In Monitor, not under Missions: nothing here asks you anything — it is watched, and at most stopped.
      { to: "/jobs", label: "Background Helpers", icon: Layers },
      // Last in Monitor because it is where you go when one of the three above did something you did
      // not expect: the daemon's own log, the audit trail, the scheduler's runs and the background
      // commands, none of which had a screen before.
      { to: "/logs", label: "System Logs", icon: ScrollText },
    ],
  },
  {
    group: "Configure",
    items: [
      { to: "/agents", label: "Agents", icon: Bot },
      // Directly under Agents, because that is the pair: an agent is an identity, a skill is a
      // procedure, and every skill is shared by every agent — so curating them is one page, not a tab
      // buried inside whichever agent you happened to open.
      { to: "/skills", label: "Skills", icon: Wrench },
      // Under Skills because it is the same shape: one library of servers, switched on per agent (0.7.19).
      { to: "/mcp", label: "Connectors", icon: Plug },
      // Beside Skills for the same reason Skills is beside Agents: an agent is an identity, a skill is
      // a procedure, and a memory is what it remembers. All three are curated in one place rather than
      // buried inside whichever agent you happened to open.
      // "Knowledge & Memory" since 0.8.20: the documents kept for the agents are a tab of it (the owner, 2026-11-03).
      { to: "/memories", label: "Knowledge & Memory", icon: Brain },
      { to: "/people", label: "People", icon: Users },
      // Beside People because it is the other half of who the agents talk with: People is the humans, Groups the rooms
      // they talk in — each WhatsApp or Telegram group, Discord channel or thread, dashboard room (0.7.24).
      { to: "/groups", label: "Groups", icon: MessagesSquare },
      // Beside People because they are the same humans: People is who they are, Access is whether they
      // may talk to the agents at all. Not beside Users — those are the dashboard's own sign-ins.
      { to: "/access", label: "Access", icon: ShieldCheck, badge: PendingAccessBadge },
      { to: "/models", label: "Models", icon: Cpu, adminOnly: true },
      // Beside Models because it is where those models come from on a Router build: the accounts
      // they are signed in with, and what they cost. Admin only — it holds every upstream credential.
      { to: "/llm-gateway", label: "LLM Gateway", icon: NougateGlyph, adminOnly: true, gatewayOnly: true }, // plain-words-ok: the admin page's own name, which keeps its terms
      // Under Models because it is the other half of the same setup: a provider profile names the
      // credential, and this is where the credential goes. Admin only, like Models, and for a
      // stronger reason — this is the write side of every token on the box.
      { to: "/secrets", label: "Secrets", icon: KeyRound, adminOnly: true },
    ],
  },
  /**
   * Its own group: the one direction that runs outward — other tools using this install. Not beside
   * an agent's MCP tab, which is the opposite direction and would read as the same thing.
   */
  {
    group: "Connect",
    items: [
      { to: "/integrations", label: "Integrations", icon: Blocks, adminOnly: true },
      // Outward too: which search service the agents reach out to.
      { to: "/web-search", label: "Web Search", icon: Search, adminOnly: true },
    ],
  },
  {
    group: "Account",
    items: [
      { to: "/account", label: "My Account", icon: UserCog },
      { to: "/users", label: "Users", icon: Users, adminOnly: true },
      { to: "/box", label: "My Box", icon: Box, adminOnly: true, boxOnly: true },
    ],
  },
  /**
   * Last, and its own group rather than an item tacked onto Account.
   *
   * The manual explains what every screen above it does, and until now the only way to it was
   * knowing the domain. A group header for one item is more weight than the item deserves on its
   * own — but it is the honest shape: this is the one entry that leaves the daemon.
   */
  {
    group: "Learn",
    items: [
      { href: `${DOCS_URL}/docs`, label: "Documentation", icon: BookOpen },
    ],
  },
];

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr });
  /**
   * Pages that own the viewport rather than growing past it.
   *
   * Everything else scrolls as a document, which is right for a page you read top to bottom. It is
   * wrong for a page whose whole content is a long list: the header, the tabs and the filters scroll
   * away with it, so filtering means scrolling back up to reach the control. Chat, System Logs and
   * Secrets keep their chrome fixed and scroll inside their own panels, and the LLM Gateway's frame
   * scrolls itself.
   *
   * Each route says so itself (`staticData`), rather than this matching the address: `includes("/chat")`
   * was also true of `/agents/chatbot/settings`, so every page of an agent called `chatbot`, `logs-bot`
   * or `secrets` lost its scrolling and its padding, with its Save buttons below the fold out of reach.
   */
  const ownsViewport = useMatches({ select: (matches) => matches.some((match) => match.staticData.ownsViewport === true) });
  /**
   * A page whose list scrolls inside its own card (`fillsViewport`): padded and centred like any page, but held to the
   * window's height, so the header and the tabs stay put and only the list moves. The page's root is
   * `FILL_PAGE` and its list a `ScrollCard fill`; the area still scrolls past the card's minimum height, so a short
   * screen, or a form open above the list, loses nothing. From a laptop's width up: on a phone such a page scrolls as a
   * document, as every other does.
   */
  const fillsViewport = useMatches({ select: (matches) => matches.some((match) => match.staticData.fillsViewport === true) });
  const gate = useGate(pathname, search);
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Whether this is a paired Box decides whether My Box exists (see `NavItem.boxOnly`). Stale for a
  // minute is fine: it changes only with the binary or a flash.
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const onBox = isPairedBox(health.data);

  useEffect(() => {
    // `href`, not `to`: the login form's address carries the page it goes on to (`?next=`).
    if (gate.redirectTo) void navigate({ href: gate.redirectTo });
  }, [gate.redirectTo, navigate]);

  useEffect(() => setDrawerOpen(false), [pathname]);

  const { signOut, dialog: signOutDialog } = useSignOut();

  if (gate.loading) {
    return (
      <div className="bg-base-200/60 flex min-h-screen items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary opacity-60" />
      </div>
    );
  }

  // Nobody known yet and the daemon not answering — a first load during a boot. Not the login form: nobody signed out.
  if (gate.offline && !gate.principal) return <ReconnectingScreen />;

  const chromeless =
    pathname.startsWith("/login") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/welcome") ||
    pathname.startsWith(MCP_LOGIN_CALLBACK);

  if (chromeless) {
    return (
      <div className="bg-base-200/50 min-h-screen text-base-content selection:bg-primary/20">
        <ReconnectingBanner offline={gate.offline} />
        <Outlet />
      </div>
    );
  }

  const admin = isAdmin(gate.principal);
  const hostsGateway = gatewayDashboard(gate.setup) !== null;
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => (!item.adminOnly || admin) && (!item.boxOnly || onBox) && (!item.gatewayOnly || hostsGateway),
    ),
  })).filter((group) => group.items.length > 0);

  const person = gate.principal?.user;
  const label = person?.displayName?.trim() ?? "";

  const sidebar = (
    <div className="bg-base-100/85 backdrop-blur-2xl border-base-content/[0.08] flex h-full w-64 flex-col border-r shadow-xs">
      {/* Brand Header */}
      <div className="border-b border-base-content/[0.08] flex h-16 items-center justify-between px-5">
        <Link to="/" className="flex items-center gap-2.5 group">
          <NovaAppIcon className="size-8 transition-transform duration-150 group-active:scale-95 drop-shadow-xs" />
          <div className="leading-tight">
            <div className="flex items-center gap-1.5">
              <p className="font-bold tracking-tight text-base-content text-sm">Nouride</p>
              <Sparkles size={11} className="text-primary/70" />
            </div>
            <SidebarVersion />
          </div>
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square text-base-content/65 hover:text-base-content active:scale-90 transition-transform lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-label="Close menu"
        >
          <X size={16} />
        </button>
      </div>

      {/* Nav Menu */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {groups.map((group) => (
          <div key={group.group} className="space-y-1">
            <p className="text-base-content/65 px-3 text-[11px] font-bold tracking-wider uppercase font-mono">
              {group.group}
            </p>
            <div className="space-y-0.5">
              {group.items.map(({ to, href, label: text, icon: Icon, badge: Badge }) =>
                href ? (
                  /**
                   * An `<a>`, not a `<Link>` — and it never carries the active style, because it is
                   * never the page you are on. `noreferrer` as well as `noopener`: the manual has no
                   * business knowing which install sent someone to it.
                   */
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-base-content/70 hover:text-base-content hover:bg-base-content/[0.05] flex items-center gap-3 rounded-xl px-3 py-2 font-mono text-[13px] font-medium transition-all duration-150 active:scale-[0.98]"
                  >
                    <Icon size={16} className="shrink-0 transition-transform group-hover:scale-105" />
                    <span className="flex-1">{text}</span>
                    {/* Said rather than left to be discovered by the tab that appears. */}
                    <ExternalLink size={12} className="shrink-0 text-base-content/35" aria-label="opens in a new tab" />
                  </a>
                ) : (
                  <Link
                    key={to}
                    to={to}
                    className="text-base-content/70 hover:text-base-content hover:bg-base-content/[0.05] flex items-center gap-3 rounded-xl px-3 py-2 font-mono text-[13px] font-medium transition-all duration-150 active:scale-[0.98]"
                    activeProps={{
                      className:
                        "flex items-center gap-3 rounded-xl px-3 py-2 font-mono text-[13px] font-semibold bg-primary/10 text-primary border border-primary/20 shadow-xs",
                    }}
                    activeOptions={{ exact: to === "/" }}
                  >
                    <Icon size={16} className="shrink-0 transition-transform group-hover:scale-105" />
                    <span>{text}</span>
                    {Badge ? <Badge /> : null}
                  </Link>
                ),
              )}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer Profile & Actions */}
      <div className="border-t border-base-content/[0.08] p-3 space-y-2 bg-base-content/[0.02]">
        <div className="flex items-center gap-3 px-2 py-1.5 rounded-xl bg-base-100/50 border border-base-content/[0.05]">
          <span className="bg-primary/10 text-primary border border-primary/20 grid size-8 shrink-0 place-items-center rounded-xl text-xs font-bold shadow-xs">
            {(label || gate.principal?.actor || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-xs font-semibold text-base-content">{label || gate.principal?.actor}</p>
            <p className="text-base-content/65 text-[11px] capitalize font-medium">{gate.principal?.role}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className="btn btn-ghost btn-xs h-8 rounded-lg gap-1.5 font-medium text-base-content/70 hover:text-base-content hover:bg-base-content/[0.06] active:scale-95 transition-all"
            onClick={toggleTheme}
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun size={13} className="text-warning" /> : <Moon size={13} />}
            <span className="text-xs">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs h-8 rounded-lg gap-1.5 font-medium text-base-content/70 hover:text-error hover:bg-error/10 active:scale-95 transition-all"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={13} />
            <span className="text-xs">Sign Out</span>
          </button>
          {signOutDialog}
        </div>
      </div>
    </div>
  );

  return (
    /* The page's edges kept clear of a phone's notch, side and top, with `viewport-fit=cover` in index.html: on a
       desktop each inset is 0. The bottom is each page's own (`PAGE_BOTTOM`), so what scrolls can pass under the
       home indicator and still end above it. */
    <div className="bg-base-200/50 h-screen h-[100dvh] flex flex-col text-base-content selection:bg-primary/20 overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Desktop Fixed Sidebar */}
      <div className="fixed inset-y-0 left-0 z-30 hidden lg:block">{sidebar}</div>

      {/* Mobile Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-200"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          />
          <div className="absolute inset-y-0 left-0 bg-base-100 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
            {sidebar}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="lg:pl-64 flex flex-col flex-1 min-h-0 h-full overflow-hidden">
        {/* Mobile Header — its two buttons a finger's size (40px), where they were 32 and 24. */}
        <header className="bg-base-100/80 backdrop-blur-xl border-b border-base-content/[0.08] shrink-0 z-20 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between px-3 pt-[env(safe-area-inset-top)] lg:hidden shadow-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-square size-10 active:scale-90 transition-transform"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="flex items-center gap-2">
              <NovaAppIcon className="size-6" />
              <span className="font-bold tracking-tight text-sm">Nouride</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-circle size-10 text-base-content/70"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun size={18} className="text-warning" /> : <Moon size={18} />}
          </button>
        </header>

        <ReconnectingBanner offline={gate.offline} />
        <RestartPendingBar />
        <RestartedToast />
        {!gate.offline && health.data && staleBundle(bundleVersion(), health.data.version) && <UpdatedBanner running={health.data.version} />}

        {ownsViewport ? (
          <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <Outlet />
          </main>
        ) : fillsViewport ? (
          /* Never sideways: a tooltip waiting unseen at the edge of a phone's screen made the page pan by a few pixels under
             a finger (a mission's turn chips). What is wider than the page is that element's to wrap or scroll. */
          <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            {/* Held to the window from a laptop's width up; on a phone it scrolls as a document, as the page beside it
                does — a list scrolling inside a card inside a scrolling page, under a header, is a sliver there. */}
            <div className={`mx-auto flex w-full max-w-6xl flex-col px-4 pt-4 sm:px-6 sm:pt-6 lg:h-full lg:p-8 ${PAGE_BOTTOM}`}>
              <Outlet />
            </div>
          </main>
        ) : (
          <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className={`mx-auto w-full max-w-6xl space-y-6 px-4 pt-4 sm:px-6 sm:pt-6 lg:p-8 ${PAGE_BOTTOM}`}>
              <Outlet />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
