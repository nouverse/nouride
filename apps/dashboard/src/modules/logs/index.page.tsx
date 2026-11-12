/**
 * Logs — the four records the daemon keeps, in one place.
 *
 * Until now every one of them was reachable only over SSH or from the CLI, which meant every
 * diagnosis on a live box went through `journalctl -u nouride` and a terminal. The four are
 * deliberately kept as separate tabs rather than merged into one stream, because they answer
 * different questions and merging them would make each one harder to read:
 *
 *   Daemon    every line the process printed. What happened.
 *   Audit     one row per decision, with an actor. Who made it happen.
 *   Schedule  what the scheduler fired, and what came back.
 *   Jobs      background commands, and whether the process is still there.
 *
 * Only the first is new storage — the other three were already tables nobody had a screen for. The
 * log's own window is short (`[retention] log_days`, three days) and settable from here, because
 * here is where somebody finds out it was too short.
 *
 * One panel per file in `components/`: they share nothing but the `Panel` they are drawn in.
 */

import { useState } from "react";
import { PageHeader } from "@/commons/components/ui/ui";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { HELD_BOTTOM } from "@/commons/components/ui/ScrollCard";
import { AuditLog } from "./components/AuditLog";
import { BackgroundJobs } from "./components/BackgroundJobs";
import { DaemonLog } from "./components/DaemonLog";
import { ScheduleRuns } from "./components/ScheduleRuns";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { isAdmin, useMe } from "@/commons/lib/session";

type Tab = "daemon" | "audit" | "schedule" | "jobs";

/**
 * `adminOnly`: every line of everybody's chats, commands and decisions is in the daemon's log and the audit log, so
 * the server answers them to an admin alone. The tab is not offered to anyone else, where it would open on a refusal.
 */
const TABS: { id: Tab; label: string; hint: string; adminOnly?: true }[] = [
  { id: "daemon", label: "Daemon", hint: "Every line the process printed", adminOnly: true },
  { id: "audit", label: "Audit", hint: "One row per decision, with an actor", adminOnly: true },
  { id: "schedule", label: "Schedule", hint: "What the scheduler fired" },
  { id: "jobs", label: "Helpers", hint: "Commands started and not waited for" },
];

export default function LogsPage() {
  const admin = isAdmin(useMe().data ?? null);
  const tabs = TABS.filter((entry) => admin || !entry.adminOnly);
  const [picked, setTab] = useState<Tab | null>(null);
  // The first tab this reader has, until they pick one of theirs.
  const tab = tabs.find((entry) => entry.id === picked)?.id ?? tabs[0]!.id;

  return (
    /**
     * Fixed chrome, scrolling panel.
     *
     * This page is one long list per tab, and letting the document scroll took the title, the tabs
     * and the filters with it — so narrowing a search meant scrolling back to the top to reach the
     * box. Everything above the panel stays; the rows move.
     *
     * From a laptop's width up. On a phone the title, the tabs and the filters took most of the screen and left the rows
     * a sliver to scroll in, so there the page scrolls as one document and the panel grows with its rows.
     */
    <div className={`flex h-full flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 pt-4 sm:px-6 sm:pt-6 lg:overflow-hidden lg:px-8 lg:pt-8 ${HELD_BOTTOM} *:animate-fade`}>
      <div className="shrink-0 space-y-4">
        <PageHeader
          ask={PAGE_ASKS.logs}
          title="Logs"
          description={
            admin
              ? "For whoever runs the server: what Nouride has been doing, who did what, what ran on a schedule and what still runs in the background, to find out why something went wrong."
              : "What ran on a schedule and what still runs in the background, to find out why something went wrong."
          }
        />

        <SegmentedTabs tabs={tabs.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} value={tab} onChange={setTab} />
      </div>

      {tab === "daemon" && <DaemonLog />}
      {tab === "audit" && <AuditLog />}
      {tab === "schedule" && <ScheduleRuns />}
      {tab === "jobs" && <BackgroundJobs />}
    </div>
  );
}
