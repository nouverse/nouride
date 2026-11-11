/**
 * Automations: everything an install does on its own, on one list, whatever starts it. What was the Schedule page and
 * the Webhooks page is here: one list, with one dropdown that narrows it to how a thing starts (at a time, when its
 * address is called, by hand), and a search over what is on the page. Each row opens the automation as a flow.
 *
 * Asked again every ten seconds, as the Schedule page was: a row's last run and its state change on their own.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import type { AutomationSummary } from "@nouride/wire";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import type { Pose } from "@/commons/components/brand/Mascot";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { useMotionList } from "@/commons/hooks/use-motion-list";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { AutomationRow } from "./components/AutomationRow";
import { counts, matches, rows, searchedIn, type StartFilter } from "./lib/list";

const FILTERS: { value: StartFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "webhook", label: "Webhooks" },
  { value: "manual", label: "Manual" },
];

/** What an empty list says: each way of starting is its own kind of thing, with nothing of it made yet. */
const NONE: Record<StartFilter, { pose: Pose; title: string; description: string }> = {
  all: { pose: "schedule", title: "No automations yet", description: 'Press "New automation", or ask an agent in a chat: "every morning at 7, sum up my mail and send it to me".' },
  scheduled: { pose: "schedule", title: "Nothing is scheduled", description: "An automation that starts at a time: every so often, at a time of day, or once." },
  webhook: { pose: "sent", title: "No webhooks yet", description: "A webhook gives an automation an address. Whatever calls that address starts it, and what was sent is handed to its first step." },
  manual: { pose: "ready", title: "Nothing to start by hand yet", description: "An automation with no time of its own: a list of steps that runs when you press Run now." },
};

export default function AutomationsPage({ start, onStart }: { start: StartFilter; onStart: (next: StartFilter) => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const list = useQuery({
    queryKey: ["automations", "list"],
    queryFn: api.automations,
    refetchInterval: 10_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 501) && count < 2,
  });
  const agentName = (id: string) => status.data?.agents.find((agent) => agent.id === id)?.displayName || id;
  const listed = list.data ? rows(list.data.automations) : undefined;
  const found = new Set(useTextFilter(listed ?? [], search, (one) => searchedIn(one, agentName)));
  const shown = (one: AutomationSummary) => matches(one, start) && found.has(one);
  const drawn = useMotionList(listed, (one) => one.id, { shown });

  if (list.isLoading) return <ListLoading shape="cards" count={4} />;
  // "Not turned on" only when the server says so (501). A start's 503 or a timeout said it too, which it was not.
  if (list.error && !list.data) {
    if (!(list.error instanceof ApiError && list.error.status === 501)) return <ErrorNote error={list.error} />;
    return (
      <div className="alert alert-warning rounded-2xl border border-warning/30 bg-warning/10 p-4 text-warning">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>Automations are not turned on for this server.</span>
      </div>
    );
  }

  const all = listed ?? [];
  const count = counts(all);
  const writable = canWrite(me.data ?? null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["automations"] });
  const none = NONE[start];

  return (
    <div className="space-y-5">
      <PageHeader
        ask={PAGE_ASKS.automations}
        // The cat beside the title while there are rows under it; with none, the empty list has the cat.
        pose={count[start] > 0 && drawn.length > 0 ? "schedule" : undefined}
        title="Automations"
        description="What your agents do on their own: at a time, when another app calls, or by hand."
        actions={
          writable ? (
            <Link to="/automations/new" className="btn btn-primary btn-sm gap-2">
              <Plus size={16} aria-hidden="true" /> New automation
            </Link>
          ) : null
        }
      />

      {all.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput value={search} onChange={setSearch} placeholder="Find an automation" className="h-11 min-w-0 flex-[1_1_14rem] rounded-full sm:h-10 sm:max-w-sm" />
          <SearchSelect named label="Starts" options={FILTERS.map((filter) => ({ ...filter, detail: String(count[filter.value]) }))} value={start} onChange={onStart} align="start" width={220} className="rounded-full" />
        </div>
      ) : null}

      {count[start] === 0 ? (
        <EmptyState
          pose={none.pose}
          title={none.title}
          description={none.description}
          action={
            writable ? (
              <Link to="/automations/new" className="btn btn-sm btn-ghost border border-base-content/10">
                New automation
              </Link>
            ) : undefined
          }
        />
      ) : drawn.length === 0 ? (
        <EmptyState pose="searching" title={`Nothing matches “${search.trim()}”`} description="The search looks in each automation's name, its agent and what its steps say." />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {drawn.map(({ key, item, motion }) => (
            <AutomationRow key={key} automation={item} home={list.data?.timezone ?? "UTC"} agentName={agentName} writable={writable} admin={isAdmin(me.data ?? null)} motion={motion} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
