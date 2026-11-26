/**
 * Open agents: the agents anyone may write to, one at a time, drawn as the Access page is.
 *
 * Not on the Access page. Nobody asks an open agent for a code, so it has nobody waiting, approved or denied, and the
 * people who wrote to one are strangers to every other agent. So each open agent's people are lists of their own, never
 * put together with another's, another open agent's included: a picker of the open agents, with no "All". The page is
 * the Access page's template, so the two read alike: its rule lines (what the agent used today, and its two limits,
 * changed on its own Access tab), then the row that stays at the top of the window with the tabs, the filter and the
 * agent, and the tab's list under it, in the same rows.
 *
 * Three tabs: **Wrote** (its conversations with strangers, an admin's to read), **Let in** (who was let in by name on
 * its connections before it was opened: no strangers to it, since the daemon answers them as anyone let in, and the
 * Access page, which leaves an open agent out, would otherwise show them nowhere while it is open), **Blocked**.
 */

import { type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Gauge, Globe, Info } from "lucide-react";
import type { AgentSummary, SenderRecord } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { todaySaid } from "@/commons/lib/open-agent";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { StickyBar } from "@/commons/components/ui/StickyBar";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { ApprovedTab, type SearchState } from "./approved.tab";
import { approvedCounted } from "./approved-count";
import { BlockedTab } from "./blocked.tab";
import { WroteTab } from "./people-who-wrote";
import type { OpenAgentsSearch, OpenAgentsTab } from "./search";
import { SenderQuery } from "./sender-line";

/** Its two limits, as one sentence. */
export function limitsSaid(limits: NonNullable<NonNullable<AgentSummary["open"]>["limits"]>): string {
  const tokens = limits.maxDailyTokens.toLocaleString("en-US");
  const messages = limits.maxDailyMessagesPerPerson.toLocaleString("en-US");
  return `At most ${tokens} tokens a day, and ${messages} ${limits.maxDailyMessagesPerPerson === 1 ? "message" : "messages"} from one person a day.`; // plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it
}

const count = (n: number | undefined) => (n ? <span className="badge badge-xs badge-ghost font-semibold font-mono">{n.toLocaleString("en-US")}</span> : null);

/** A rule line, as the Access page says its own: an icon and a sentence. */
function Rule({ icon: Icon, children }: { icon: typeof Info; children: ReactNode }) {
  return (
    <p className="text-base-content/65 text-sm flex items-start gap-2">
      <Icon size={14} className="text-primary mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A search typed for one agent's list, kept for that agent: another picked opens on its own newest. */
function usePerAgent(agent: string | undefined) {
  const [kept, setKept] = useState({ agent: "", words: "" });
  return [kept.agent === agent ? kept.words : "", (words: string) => setKept({ agent: agent ?? "", words })] as const;
}

/** Rows on this page are one agent's: none says whose connection it wrote to. */
const nobodys = () => undefined;

export default function OpenAgentsPage({ search, onSearch }: { search: OpenAgentsSearch; onSearch: (next: OpenAgentsSearch) => void }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const open = (status.data?.agents ?? []).filter((one) => one.access === "open");
  const picked = open.find((one) => one.id === search.agent) ?? open[0];
  const tab: OpenAgentsTab = search.tab ?? "wrote";
  /** One filter for whichever tab is open, in the row that stays at the top of the window, as on the Access page. */
  const [query, setQuery] = useState("");
  const [letInFound, setLetInFound] = usePerAgent(picked?.id);
  const [wroteFound, setWroteFound] = usePerAgent(picked?.id);
  // Its listing, never narrowed by a search: what the tabs count and Blocked lists.
  const access = useQuery({ queryKey: ["access"], queryFn: () => api.access(), refetchInterval: 15_000, retry: false });
  /** How many conversations it has in all: the Wrote tab's count, whatever is searched in it. An admin's to read. */
  const wrote = useQuery({ queryKey: ["agent-public", picked?.id, "count"], queryFn: () => api.agentPublic(picked!.id), enabled: picked !== undefined && admin, refetchInterval: 30_000 });

  // A link from before, to an agent that has been closed since: its people are back on the Access page.
  const closed = search.agent !== undefined && status.data && !open.some((one) => one.id === search.agent) ? search.agent : null;
  const agentOf = (gatewayId: string) => gateways.data?.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
  const its = (gatewayId: string) => picked !== undefined && agentOf(gatewayId) === picked.id;
  const blocked = picked ? (access.data?.senders ?? []).filter((sender) => sender.status === "blocked" && its(sender.gatewayId)) : [];
  const approvedOf = (senders: readonly SenderRecord[] = []) => senders.filter((sender) => sender.status === "approved" && its(sender.gatewayId));
  const listedLetIn = approvedOf(access.data?.senders);
  const letInTotal = approvedCounted(access.data, listedLetIn.length, { inScope: its, found: "", wholeInstall: false, onOpen: () => false });
  /**
   * A search of everyone let in, asked of its own connections only: across the install, another agent's many would
   * fill the newest the daemon sends and crowd its out. Apart from the listing, so a search never narrows Blocked, and
   * one on its way or not come back is said as that, never answered with the list from before.
   */
  const ownConnections = (gateways.data?.gateways ?? []).filter((gateway) => gateway.agent === picked?.id).map((gateway) => gateway.id);
  const searched = useQuery({
    queryKey: ["access", letInFound, ...ownConnections],
    queryFn: () => api.access(letInFound, ownConnections),
    enabled: Boolean(letInFound) && gateways.data !== undefined,
    retry: false,
  });
  const letIn = letInFound ? approvedOf(searched.data?.senders) : listedLetIn;
  const letInSearch: SearchState = !letInFound || searched.data ? "done" : searched.error ? "failed" : "looking";
  // Entries of the config's list named for one of its connections; a bare id is every connection's, not its own.
  const allowed = (access.data?.allowlist ?? []).filter((id) => {
    const at = id.lastIndexOf(":");
    return id.indexOf(":") < at && its(id.slice(0, at));
  });
  const name = picked ? picked.displayName || picked.id : "";

  return (
    // A tab's panel fades in as it is drawn (`*:animate-fade`), as on the Access page.
    <div className="space-y-6 *:animate-fade">
      <PageHeader title="Open agents" description="The agents anyone may write to, with no code: who wrote to each, who was let in by name, and who is kept out." />

      {closed ? (
        <p className="text-base-content/65 text-sm flex items-start gap-2" data-open-closed>
          <Info size={14} className="text-info mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {closed} is not open to everyone now, so who writes to it is on the{" "}
            <Link to="/access" search={{ agent: closed }} className="link link-primary">
              Access page
            </Link>
            .
          </span>
        </p>
      ) : null}

      {status.isPending ? (
        <ListLoading />
      ) : !picked ? (
        <Card>
          <EmptyState
            icon={Globe}
            title="No agent is open to everyone"
            description="An admin opens an agent to everyone on that agent's own Access tab. Until then, everyone who writes to your agents is on the Access page."
            action={
              <Link to="/agents" className="btn btn-sm rounded-xl">
                Your agents
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="space-y-2" data-open-today>
            {picked.open?.today && picked.open.limits ? <Rule icon={Activity}>{todaySaid(picked.open.today, picked.open.limits.maxDailyTokens)}</Rule> : null}
            {picked.open?.limits ? (
              <Rule icon={Gauge}>
                {limitsSaid(picked.open.limits)} Change them on{" "}
                <Link to="/agents/$agentId/access" params={{ agentId: picked.id }} className="link link-primary">
                  its Access tab
                </Link>
                .
              </Rule>
            ) : null}
          </div>

          {/* The tabs, the filter and the agent stay at the top of the window while the list scrolls under them. */}
          <StickyBar
            label="Whose people"
            tools={
              <>
                <SearchInput value={query} onChange={setQuery} placeholder="Filter people" className="w-48" />
                {/* Open agents only, with no "All": one agent's people at a time. Held to the row's width: a long name is cut in the button. */}
                <SearchSelect
                  small
                  className="max-w-full"
                  label="Agent"
                  options={open.map((one) => ({ value: one.id, label: one.displayName || one.id }))}
                  value={picked.id}
                  onChange={(agent) => onSearch({ ...search, agent })}
                  width={208}
                />
              </>
            }
          >
            <SegmentedTabs
              tabs={[
                { value: "wrote", label: "Wrote", after: count(admin ? wrote.data?.total : undefined) },
                { value: "let-in", label: "Let in", after: count(access.data ? letInTotal : undefined) },
                { value: "blocked", label: "Blocked", after: count(blocked.length) },
              ]}
              value={tab}
              onChange={(next) => onSearch({ ...search, tab: next })}
            />
          </StickyBar>

          <SenderQuery.Provider value={{ query, setQuery }}>
            <div key={picked.id}>
              {tab === "wrote" ? (
                admin ? (
                  <WroteTab agent={picked} found={wroteFound} onFind={setWroteFound} />
                ) : (
                  <Card title="Wrote">
                    <p className="text-base-content/65 text-sm">Only an admin reads who wrote to it, and what they said.</p>
                  </Card>
                )
              ) : access.isPending ? (
                <ListLoading />
              ) : tab === "let-in" ? (
                <ApprovedTab
                  senders={letIn}
                  allowlist={allowed}
                  blocked={blocked}
                  agentOf={nobodys}
                  total={letInFound ? letIn.length : letInTotal}
                  found={letInFound}
                  onFind={setLetInFound}
                  letInOn={name}
                  searching={letInSearch}
                />
              ) : (
                <BlockedTab senders={blocked} agentOf={nobodys} whileOpen />
              )}
            </div>
          </SenderQuery.Provider>
        </>
      )}
    </div>
  );
}
