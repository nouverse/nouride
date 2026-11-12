/**
 * Automations: everything an install does on its own, on one list, whatever starts it. What was the Schedule page and
 * the Webhooks page is here: one list, with one dropdown that narrows it to how a thing starts (at a time, when its
 * address is called, by hand), and a search over what is on the page. Each row opens the automation as a flow.
 *
 * The list is the reader's own: what they made, and what reports to a chat of theirs. An admin picks whose beside the
 * search, as on Chats: everyone's, set apart by person with what is nobody's last, one person's, or nobody's alone.
 * Under an admin's own list a line says how many more there are, so a short list is not read as the rest being gone.
 *
 * Asked again every ten seconds, as the Schedule page was: a row's last run and its state change on their own.
 *
 * Under the head, the quiet hours: the one setting here that is every automation's, and the server's.
 */

import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import type { AutomationSummary } from "@nouride/wire";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import type { Pose } from "@/commons/components/brand/Mascot";
import { Elsewhere, elsewhereWords, ShowEveryone } from "@/commons/components/people/Elsewhere";
import { PeopleFilter } from "@/commons/components/people/PeopleFilter";
import { PersonSection } from "@/commons/components/people/PersonSection";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { useMotionList, type Moving } from "@/commons/hooks/use-motion-list";
import { useWhose, type Whose } from "@/commons/hooks/use-whose";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { byPerson, NOBODYS } from "@/commons/lib/by-person";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { AutomationRow } from "./components/AutomationRow";
import { QuietHours } from "./components/QuietHours";
import { counts, matches, rows, searchedIn, type StartFilter } from "./lib/list";

const FILTERS: { value: StartFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "webhook", label: "Webhooks" },
  { value: "manual", label: "Manual" },
];

interface None {
  pose: Pose;
  title: string;
  description: string;
}

/** What an empty list says: each way of starting is its own kind of thing, with nothing of it made yet. */
const NONE: Record<StartFilter, None> = {
  all: { pose: "schedule", title: "No automations yet", description: 'Press "New automation", or ask an agent in a chat: "every morning at 7, sum up my mail and send it to me".' },
  scheduled: { pose: "schedule", title: "Nothing is scheduled", description: "An automation that starts at a time: every so often, at a time of day, or once." },
  webhook: { pose: "sent", title: "No webhooks yet", description: "A webhook gives an automation an address. Whatever calls that address starts it, and what was sent is handed to its first step." },
  manual: { pose: "ready", title: "Nothing to start by hand yet", description: "An automation with no time of its own: a list of steps that runs when you press Run now." },
};

/** What it says where an admin looked at someone else's and found none: whose was looked at, not how to make one. */
function noneOf(whose: Whose): None {
  if (whose === "everyone") return { pose: "searching", title: "No automations yet", description: "Nobody here has made one." };
  if (whose === "unknown") return { pose: "searching", title: "None without a person", description: "Every automation here belongs to someone in People." };
  return { pose: "searching", title: "Nothing of theirs yet", description: "They have made no automation, and none reports to a chat of theirs." };
}

const GRID = "grid grid-cols-1 items-start gap-4 lg:grid-cols-2";

export default function AutomationsPage({ start, onStart }: { start: StartFilter; onStart: (next: StartFilter) => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // An admin reads their own unless they pick otherwise beside the search; anyone else has their own, and no choice.
  const { whose, setWhose, canPick } = useWhose("automations");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const list = useQuery({
    queryKey: ["automations", "list", whose],
    queryFn: () => api.automations(whose),
    refetchInterval: 10_000,
    // The page keeps its head while another person's list is on its way: the picker just pressed is not drawn anew.
    placeholderData: keepPreviousData,
    retry: (count, error) => !(error instanceof ApiError && error.status === 501) && count < 2,
  });
  // Who the reader is in People: theirs come first where the list is set apart by person.
  const self = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe, staleTime: 60_000, enabled: canPick });
  const agentName = (id: string) => status.data?.agents.find((agent) => agent.id === id)?.displayName || id;
  // What the page holds: the list asked for, or the one before it while that is on its way, which is not drawn.
  const held = list.data ? rows(list.data.automations) : [];
  const arriving = list.isPlaceholderData;
  const listed = list.data && !arriving ? held : undefined;
  const found = new Set(useTextFilter(listed ?? [], search, (one) => searchedIn(one, agentName)));
  const shown = (one: AutomationSummary) => matches(one, start) && found.has(one);
  const drawn = useMotionList(listed, (one) => one.id, { shown, scope: whose });

  if (list.isLoading) return <ListLoading shape="cards" count={4} />;
  const failed = list.error && !list.data ? list.error : null;
  // "Not turned on" only when the server says so (501). A start's 503 or a timeout said it too, which it was not.
  if (failed instanceof ApiError && failed.status === 501) {
    return (
      <div className="alert alert-warning rounded-2xl border border-warning/30 bg-warning/10 p-4 text-warning">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>Automations are not turned on for this server.</span>
      </div>
    );
  }

  const count = counts(held);
  const writable = canWrite(me.data ?? null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["automations"] });
  const none = whose !== "mine" && start === "all" ? noneOf(whose) : NONE[start];
  // How many more an admin's own list leaves out: the daemon's count, and only of the list now on the page.
  const elsewhere = !failed && !arriving ? (list.data?.elsewhere ?? 0) : 0;
  const everyone = () => setWhose("everyone");
  // Set apart by person wherever it is not the reader's own list: the person looked at first, or the reader.
  const groups = whose === "mine" ? null : byPerson(drawn, (one) => one.item.person, whose.startsWith("person:") ? whose.slice("person:".length) : self.data?.person?.key);
  const row = ({ key, item, motion }: Moving<AutomationSummary>) => (
    <AutomationRow key={key} automation={item} home={list.data?.timezone ?? "UTC"} agentName={agentName} writable={writable} admin={isAdmin(me.data ?? null)} motion={motion} onChanged={refresh} />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        ask={PAGE_ASKS.automations}
        // The cat beside the title while there are rows under it, or on their way; with none, the empty list has the cat.
        pose={!failed && (arriving || (count[start] > 0 && drawn.length > 0)) ? "schedule" : undefined}
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

      {/* One setting for every automation here, said under the head: not one of the list's filters, which come next. */}
      <QuietHours />

      {/* The picker stays where a list is empty: it is how an admin gets from nobody's back to their own. */}
      {held.length > 0 || canPick ? (
        <div className="flex flex-wrap items-center gap-2.5">
          {held.length > 0 ? <SearchInput value={search} onChange={setSearch} placeholder="Find an automation" className="h-11 min-w-0 flex-[1_1_14rem] rounded-full sm:h-10 sm:max-w-sm" /> : null}
          {canPick ? <PeopleFilter value={whose} onChange={setWhose} label="Whose automations" nobody={NOBODYS} className="rounded-full" /> : null}
          {held.length > 0 ? (
            <SearchSelect named label="Starts" options={FILTERS.map((filter) => ({ ...filter, detail: String(count[filter.value]) }))} value={start} onChange={onStart} align="start" width={220} className="rounded-full" />
          ) : null}
        </div>
      ) : null}

      {failed ? (
        <ErrorNote error={failed} />
      ) : arriving ? (
        <ListLoading shape="cards" count={4} />
      ) : held.length === 0 && elsewhere > 0 ? (
        // None of their own, and others have some: said here, so an empty page is not read as everything gone.
        <EmptyState pose="schedule" title="No automations of yours yet" description={elsewhereWords(elsewhere)} action={<ShowEveryone onPress={everyone} />} />
      ) : count[start] === 0 ? (
        <EmptyState
          pose={none.pose}
          title={none.title}
          description={none.description}
          action={
            writable && whose === "mine" ? (
              <Link to="/automations/new" className="btn btn-sm btn-ghost border border-base-content/10">
                New automation
              </Link>
            ) : undefined
          }
        />
      ) : drawn.length === 0 ? (
        <EmptyState pose="searching" title={`Nothing matches “${search.trim()}”`} description="The search looks in each automation's name, its agent and what its steps say." />
      ) : groups ? (
        <div className="space-y-7">
          {groups.map((group) => (
            <PersonSection key={group.key} label={group.label} count={group.items.length}>
              <div className={GRID}>{group.items.map(row)}</div>
            </PersonSection>
          ))}
        </div>
      ) : (
        <div className={GRID}>{drawn.map(row)}</div>
      )}
      {elsewhere > 0 && held.length > 0 ? <Elsewhere count={elsewhere} onEveryone={everyone} /> : null}
    </div>
  );
}
