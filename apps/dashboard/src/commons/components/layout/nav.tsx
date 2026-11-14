/**
 * The menu, by how often a page is opened (0.8.24). Four a person uses every day and
 * always sees, two now and then, and everything set up once behind Settings:
 *
 * - **Home, Chats, Work, Agents.** Work holds what agents do without anyone in the chat: what waits for an answer,
 *   automations (work a clock, another app or a person starts), missions and helpers, under one badge. Agents holds the Office, the same agents drawn as cats.
 * - **Skills, Connectors, Memory.** Connectors is the library of outside tools, switched on per agent as skills are.
 *   Memory holds what the agents know, and the people and groups they know it about.
 * - **Settings**, a page of its own that lists every other page, and opens its list here only while one of them is the
 *   page you are on: shown always, fourteen links were the menu, and the four that matter were lost among them.
 *
 * The same sections on a phone: the first four in the tab bar, the rest in More. The manual is not in it: it is at the
 * foot of Settings, and a menu entry that leaves the dashboard was one more line for something opened rarely.
 */

import { Link } from "@tanstack/react-router";
import { useRef, type ComponentType } from "react";
import {
  Activity,
  Blocks,
  Box,
  Brain,
  Cat,
  Cpu,
  Download,
  House,
  KeyRound,
  MessageSquare,
  Plug,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Target,
  UserCog,
  Users,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NougateGlyph } from "@/commons/components/brand/logos";
import { NavHighlight } from "@/commons/components/layout/NavHighlight";
import { useNeedsYou } from "@/commons/hooks/use-needs-you";
import { cn } from "@/commons/lib/utils";

export interface NavItem {
  to: string;
  label: string;
  /** A Lucide icon, or anything drawn the same way — `NougateGlyph` takes `size` like one. */
  icon: LucideIcon | ComponentType<{ size?: number; className?: string }>;
  /** The other pages this one's section holds: the item is the page you are on while one of them is. */
  holds?: string[];
  /** Something waiting there, drawn after the label — and nothing when nothing is. */
  badge?: ComponentType;
  adminOnly?: boolean;
  /** Left out for an admin, who reaches the page another way: Logs is a tab of System for them. */
  exceptAdmin?: boolean;
  /**
   * Shown only on a paired Box. My Box is served by the appliance plugin, which is active only on a box it was flashed
   * onto — the same Pro edition in a pod has nothing behind the page.
   */
  boxOnly?: boolean;
  /**
   * Shown only where the build carries the LLM gateway, on or off: off, the page is where it is turned on. On a daemon
   * older than the switch, only where it runs and the dashboard bundle beside the binary can be shown in a frame —
   * `gatewayPage` and `gatewayDashboard` have why.
   */
  gatewayOnly?: boolean;
  /** A line under its name on the Settings page: what the page is for, in a person's words. */
  about?: string;
}

/** A count in the needs-you pink: something here waits for the person. */
function NeedsBadge({ n, label }: { n: number; label: string }) {
  if (n === 0) return null;
  return (
    <span className="badge badge-sm ml-auto border-0 bg-accent/15 px-1.5 font-mono font-semibold text-accent" title={label}>
      {n}
    </span>
  );
}

function WorkBadge() {
  const { approvals, missions, steps } = useNeedsYou();
  const waiting = approvals + missions + steps;
  return <NeedsBadge n={waiting} label={`${waiting} waiting for your answer`} />;
}

function SkillsBadge() {
  const { skills } = useNeedsYou();
  return <NeedsBadge n={skills} label={`${skills} waiting for review`} />;
}

function MemoryBadge() {
  const { facts, documents } = useNeedsYou();
  const n = facts + documents.reduce((sum, one) => sum + one.count, 0);
  return <NeedsBadge n={n} label={`${n} waiting for your review`} />;
}

function AccessBadge() {
  const { requests } = useNeedsYou();
  return <NeedsBadge n={requests} label={`${requests} waiting to be approved`} />;
}

/** Every day, always in view: on a phone, the tab bar. */
export const DAILY: NavItem[] = [
  { to: "/", label: "Home", icon: House },
  { to: "/chat", label: "Chats", icon: MessageSquare },
  { to: "/work", label: "Work", icon: Target, holds: ["/automations", "/missions", "/jobs"], badge: WorkBadge },
  // A cat, as every agent is one here, where it was a robot.
  { to: "/agents", label: "Agents", icon: Cat, holds: ["/office"] },
];

/** Now and then. */
const OCCASIONAL: NavItem[] = [
  { to: "/skills", label: "Skills", icon: Wrench, badge: SkillsBadge },
  // Under Skills, the same shape: one library of outside tools, switched on per agent.
  { to: "/mcp", label: "Connectors", icon: Plug },
  { to: "/memories", label: "Memory", icon: Brain, holds: ["/people", "/groups"], badge: MemoryBadge },
  // An admin's: what the machine is using, what Nouride logged, the files it keeps and its update, as four tabs.
  { to: "/system", label: "System", icon: Activity, holds: ["/logs", "/files", "/update"], adminOnly: true },
];

/**
 * Set up once and visited when something changes, in the groups the Settings page shows them in. Each group's
 * order is the order a person setting up a box meets them.
 */
export const SETTINGS: { group: string; items: NavItem[] }[] = [
  {
    group: "Models and keys",
    items: [
      // The gateway above Models: where it runs, the models are reached through it.
      { to: "/llm-gateway", label: "LLM Gateway", icon: NougateGlyph, adminOnly: true, gatewayOnly: true, about: "The AI accounts this box shares, and what they cost." }, // plain-words-ok: the admin page's own name, which keeps its terms
      { to: "/models", label: "Models", icon: Cpu, adminOnly: true, about: "Which AI each agent thinks with, and the accounts it is reached through." },
      { to: "/secrets", label: "Secrets", icon: KeyRound, adminOnly: true, about: "Passwords and keys the agents use, kept encrypted on this box." },
    ],
  },
  {
    group: "Reaching out",
    items: [
      { to: "/integrations", label: "Integrations", icon: Blocks, adminOnly: true, about: "Other apps that use this box's agents." },
      { to: "/web-search", label: "Web Search", icon: Search, adminOnly: true, about: "Which search service the agents look things up with." },
    ],
  },
  {
    group: "People and sign-in",
    items: [
      { to: "/access", label: "Access", icon: ShieldCheck, badge: AccessBadge, about: "Who may talk to the agents, and who is asking to." },
      { to: "/users", label: "Users", icon: Users, adminOnly: true, about: "Who can sign in to this dashboard." },
      { to: "/account", label: "My Account", icon: UserCog, about: "Your name and your password." },
    ],
  },
  {
    group: "This box",
    items: [
      { to: "/box", label: "My Box", icon: Box, adminOnly: true, boxOnly: true, about: "The box itself: its network, its storage and its updates." },
      { to: "/logs", label: "Logs", icon: ScrollText, exceptAdmin: true, about: "What the agents and the box did, line by line, for when something went wrong." },
      // A tab of System for an admin, as Logs is; for anyone else it is here, where it always was.
      { to: "/update", label: "Update", icon: Download, exceptAdmin: true, about: "The newest version of Nouride, and installing it." },
    ],
  },
];

/** Where the Settings page itself lives. */
export const SETTINGS_HOME = "/settings";

/** Whether `item` is the page you are on: its own address or one under it, or a page its section holds. */
export function isCurrent(item: Pick<NavItem, "to" | "holds">, pathname: string): boolean {
  const under = (to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));
  return under(item.to) || (item.holds ?? []).some(under);
}

/** The pages this person may see: what is for admins, for a paired box or for a hosted gateway, only there. */
export function visible(items: NavItem[], where: { admin: boolean; onBox: boolean; hostsGateway: boolean }): NavItem[] {
  return items.filter((item) => (!item.adminOnly || where.admin) && (!item.exceptAdmin || !where.admin) && (!item.boxOnly || where.onBox) && (!item.gatewayOnly || where.hostsGateway));
}

const ITEM = "flex min-h-11 items-center gap-3 rounded-[14px] px-3 text-sm transition-colors duration-150 active:scale-[0.98] lg:min-h-10";

/** Folded to its icon (`CompactSidebar`): the icon over a short name, and what waits there as a count on its corner. */
const TILE = "relative flex w-16 flex-col items-center gap-1 rounded-[14px] py-2 text-[10px] transition-colors duration-150 active:scale-[0.98]";

function NavLink({ item, pathname, small = false, compact = false, className }: { item: NavItem; pathname: string; small?: boolean; compact?: boolean; className?: string }) {
  const { to, label, icon: Icon, badge: Badge } = item;
  const current = isCurrent(item, pathname);
  if (compact) {
    return (
      <Link
        to={to}
        activeOptions={{ exact: to === "/" }}
        aria-current={current ? "page" : undefined}
        aria-label={label}
        title={label}
        className={cn(TILE, current ? "font-semibold text-secondary" : "font-medium text-base-content/70 hover:bg-base-content/[0.05] hover:text-base-content")}
      >
        <Icon size={18} className="shrink-0" aria-hidden="true" />
        <span aria-hidden="true" className="max-w-full truncate px-1">{label}</span>
        {Badge ? (
          <span className="absolute -top-0.5 right-1 [&_.badge]:ml-0">
            <Badge />
          </span>
        ) : null}
      </Link>
    );
  }
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      aria-current={current ? "page" : undefined}
      className={cn(ITEM, small && "min-h-9 pl-10 text-[13px] lg:min-h-8", current ? "font-semibold text-secondary" : "font-medium text-base-content/70 hover:bg-base-content/[0.05] hover:text-base-content", className)}
    >
      {!small && <Icon size={17} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {Badge ? <Badge /> : null}
    </Link>
  );
}

/**
 * The menu itself, the sidebar's and More's: the page you are on is marked by the one highlight under the items, which
 * moves to the item you open. In More, the daily four are left out: the tab bar under it has them.
 */
export function SidebarNav({ pathname, where, compact = false }: { pathname: string; where: { admin: boolean; onBox: boolean; hostsGateway: boolean }; compact?: boolean }) {
  const nav = useRef<HTMLElement>(null);
  const settings = SETTINGS.map((group) => ({ ...group, items: visible(group.items, where) })).filter((group) => group.items.length > 0);
  const inSettings = pathname === SETTINGS_HOME || settings.some((group) => group.items.some((item) => isCurrent(item, pathname)));
  /** Every address among Settings' pages: what a phone's one Settings line is marked on. */
  const settingsPages = settings.flatMap((group) => group.items).flatMap((item) => [item.to, ...(item.holds ?? [])]);
  if (compact) {
    return (
      <nav ref={nav} aria-label="Menu" className="relative isolate flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto px-2 py-3">
        <NavHighlight nav={nav} />
        {[...DAILY, ...visible(OCCASIONAL, where), { to: SETTINGS_HOME, label: "Settings", icon: Settings, badge: AccessBadge }].map((item) => (
          <NavLink key={item.to} item={item} pathname={pathname} compact />
        ))}
      </nav>
    );
  }
  return (
    <nav ref={nav} aria-label="Menu" className="relative isolate flex-1 space-y-4 overflow-y-auto px-3 py-4">
      <NavHighlight nav={nav} />
      <div className="space-y-0.5 max-lg:hidden">
        {DAILY.map((item) => (
          <NavLink key={item.to} item={item} pathname={pathname} />
        ))}
      </div>
      <div className="space-y-0.5">
        {visible(OCCASIONAL, where).map((item) => (
          <NavLink key={item.to} item={item} pathname={pathname} />
        ))}
        {/*
          On a phone, in More, Settings is one line and stays one: its pages are listed on the Settings page itself, and
          among them it is Settings that is marked. Listed in the sheet too, they made it grow as it slid away (to most
          of the screen, over the tab bar), and a tap meant for a tab opened one of them.
        */}
        <NavLink className="lg:hidden" item={{ to: SETTINGS_HOME, label: "Settings", icon: Settings, badge: AccessBadge, holds: settingsPages }} pathname={pathname} />
        {/* Its list folded away, a request to talk to the agents is counted on Settings, as it is on Access once open. */}
        <NavLink className="max-lg:hidden" item={{ to: SETTINGS_HOME, label: "Settings", icon: Settings, ...(inSettings ? {} : { badge: AccessBadge }) }} pathname={pathname} />
        {/* Settings' own pages, while you are among them: the page you are on is marked as one of them, not as Settings. */}
        {inSettings && (
          <div className="space-y-0.5 animate-fade max-lg:hidden">
            {settings.flatMap((group) => group.items).map((item) => (
              <NavLink key={item.to} item={item} pathname={pathname} small />
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
