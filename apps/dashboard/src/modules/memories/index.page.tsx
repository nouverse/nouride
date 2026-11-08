/**
 * Knowledge & Memory — the documents kept for the agents (0.8.20, KNOWLEDGE_BASE §11), what the agents learn about
 * people, and the conversations they learn it from (`docs/SPEC.md` §12). "Memory" until 0.8.20, renamed with the
 * knowledge base it now holds too (the owner, 2026-11-03).
 *
 * Tabs rather than pages, because it is one subject seen from the angles a person comes to it with:
 * the documents kept on purpose (Knowledge, first, as in the menu's name), what each agent keeps for
 * itself (Agent notes), what is known about each person (People), what happened when and whether the
 * nightly pass is doing its job (Timeline), what every agent knows (Shared), what waits for a decision
 * (Proposals), and how it is set up (Settings). Other tools reaching it over MCP is Integrations, its
 * own menu: it serves personas too.
 *
 * Every tab reads memory unfiltered by audience, so the whole menu is an operator's.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, Waypoints } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { NotesTab } from "./notes.tab";
import { PeopleTab } from "./people.tab";
import { ProposalsTab } from "./proposals.tab";
import { SettingsTab } from "./settings.tab";
import { SharedTab } from "./shared.tab";
import { MemorySummary } from "./summary";
import { TagsCard, TidyTagsButton } from "./tags-card";
import { TimelineTab } from "./timeline.tab";
import { KnowledgeTab } from "./knowledge/knowledge.tab";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";

export type MemoryTab = "knowledge" | "notes" | "people" | "timeline" | "shared" | "proposals" | "settings";
type Tab = MemoryTab;

export const MEMORY_TABS: { value: Tab; label: string }[] = [
  { value: "knowledge", label: "Knowledge" },
  { value: "notes", label: "Agent notes" },
  { value: "people", label: "People" },
  { value: "timeline", label: "Timeline" },
  { value: "shared", label: "Shared" },
  { value: "proposals", label: "Proposals" },
  { value: "settings", label: "Settings" },
];

export default function MemoriesPage({ tab: opened }: { tab?: MemoryTab } = {}) {
  const me = useMe();
  const operator = canWrite(me.data ?? null);
  const admin = isAdmin(me.data ?? null);
  const [tab, setTab] = useState<Tab>(opened ?? "knowledge");
  // A link to another tab, followed while the page is open, opens that tab.
  useEffect(() => {
    if (opened) setTab(opened);
  }, [opened]);

  const proposals = useQuery({ queryKey: ["memory-proposals"], queryFn: api.memoryProposals, enabled: operator });
  const waiting = proposals.data?.proposals.length ?? 0;

  return (
    // A tab's panel fades in as it is drawn (`*:animate-fade`), as every section that appears here does.
    <div className="space-y-6 *:animate-fade">
      <PageHeader
        title="Knowledge & Memory"
        description="The documents you keep for your agents, and what they remember from conversations."
        actions={operator ? <TidyTagsButton /> : null}
      />

      {!operator && me.data ? <EmptyState icon={Lock} title="Operators only" description="This holds what agents know about people, and the documents kept for them, so only an operator can open it." /> : null}

      {operator ? <MemorySummary waiting={waiting} /> : null}
      {operator ? <TagsCard /> : null}

      {operator ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedTabs
            tabs={MEMORY_TABS.map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.value === "proposals" && waiting > 0 ? { after: <span className="badge badge-xs badge-warning font-mono">{waiting}</span> } : {}),
            }))}
            value={tab}
            onChange={setTab}
          />
          {/* Its own page, not a tab: it wants the whole screen, and only loads its renderer when opened. */}
          <Link
            to="/memories/graph"
            className="group inline-flex items-center gap-2 rounded-2xl border border-base-content/[0.08] bg-base-100 px-4 py-2.5 text-xs font-semibold text-base-content/80 shadow-xs transition-all hover:border-primary/40 hover:text-primary active:scale-95 sm:text-sm"
          >
            <Waypoints size={16} className="text-primary transition-transform group-hover:rotate-12" />
            Graph view
          </Link>
        </div>
      ) : null}

      {operator && tab === "knowledge" ? <KnowledgeTab editable={operator} admin={admin} /> : null}
      {operator && tab === "people" ? <PeopleTab editable={operator} admin={admin} /> : null}
      {operator && tab === "timeline" ? <TimelineTab editable={operator} /> : null}
      {operator && tab === "shared" ? <SharedTab editable={operator} /> : null}
      {operator && tab === "notes" ? <NotesTab editable={operator} /> : null}
      {operator && tab === "proposals" ? <ProposalsTab editable={operator} /> : null}
      {operator && tab === "settings" ? <SettingsTab editable={operator} admin={admin} /> : null}
    </div>
  );
}
