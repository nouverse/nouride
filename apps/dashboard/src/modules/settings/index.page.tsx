/**
 * Settings (0.8.24): every page that is set up once and visited when something changes, in groups, each with a line
 * on what it is for, and a search over the names and those lines. It is the menu's Settings, where fourteen links
 * were the menu before; the groups and the lines are `nav.tsx`'s, so the sidebar and this page cannot disagree.
 */

import { LIFTS } from "@/commons/components/ui/CardGrid";
import { cn } from "@/commons/lib/utils";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowUpRight, BookOpen, Download } from "lucide-react";
import { api } from "@/commons/lib/api";
import { isPairedBox } from "@/commons/lib/api.appliance";
import { gatewayDashboard } from "@/commons/lib/bundled-gateway";
import { DOCS_URL } from "@/commons/lib/docs";
import { isAdmin, useMe } from "@/commons/lib/session";
import { SETTINGS, visible, type NavItem } from "@/commons/components/layout/nav";
import { EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { RestartButton } from "@/commons/components/box/RestartButton";

/** The box's own pages that are not in the menu: its update, and the manual. */
const EXTRA: Record<string, NavItem[]> = {
  "This box": [{ to: "/update", label: "Update", icon: Download, about: "The newest version of Nouride, and installing it." }],
};

function matches(item: NavItem, words: string): boolean {
  const text = `${item.label} ${item.about ?? ""}`.toLowerCase();
  return words.split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

export default function SettingsPage() {
  // The shell's own queries, asked again by the same keys: answered from the cache, not the daemon.
  const me = useMe();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const where = { admin: isAdmin(me.data ?? null), onBox: isPairedBox(health.data), hostsGateway: gatewayDashboard(setup.data ?? null) !== null };
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const groups = SETTINGS.map((group) => ({ group: group.group, items: visible([...group.items, ...(EXTRA[group.group] ?? [])], where).filter((item) => matches(item, words)) })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Everything you set up once: the AI your agents use, who may talk to them, and the box itself." />
      <div className="max-w-md">
        <SearchInput value={query} onChange={setQuery} placeholder="Find a setting" />
      </div>
      {groups.length === 0 ? (
        <EmptyState pose="searching" title="No setting by that name" description="Try another word, or clear the search to see them all." />
      ) : (
        groups.map(({ group, items }) => (
          <section key={group} className="space-y-3">
            <h2 className="text-lg text-base-content">{group}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map(({ to, label, icon: Icon, about, badge: Badge }) => (
                <Link key={to} to={to} className={cn("group flex items-start gap-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft active:scale-[0.99]", LIFTS)}>
                  <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-secondary/10 text-secondary">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex items-center gap-2 font-semibold text-base-content">
                      {label}
                      {Badge ? <Badge /> : null}
                    </span>
                    {about && <span className="block text-sm leading-snug text-base-content/65">{about}</span>}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
      {/* Not a page: a restart (shown to whoever may restart, as on Home), and the manual, which leaves the dashboard. */}
      {!words && (
        <div className="flex flex-wrap items-center gap-2.5">
          <RestartButton />
          <a href={`${DOCS_URL}/docs`} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm gap-1.5">
            <BookOpen size={15} aria-hidden="true" />
            Documentation
            <ArrowUpRight size={13} aria-label="opens in a new tab" />
          </a>
        </div>
      )}
    </div>
  );
}
