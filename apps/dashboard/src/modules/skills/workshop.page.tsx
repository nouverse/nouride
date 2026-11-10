/**
 * Skills Workshop — everything an agent knows, everything one has proposed, and the dial between them.
 *
 * The per-agent page answers "what does this agent know". This one answers the two questions that
 * only exist once skills are shared and agents can propose: **who has this skill and does this host
 * have what it needs**, and **what is being suggested that nobody has decided on**.
 *
 * ## Tabs, and why not one list
 *
 * A pool skill and a draft are not the same kind of thing — one is in every agent's prompt right now,
 * the other is a suggestion with no effect at all — so they cannot share a row shape without one of
 * them lying. But they *are* one workflow: you decide on a draft by looking at what is already in the
 * pool. Hence tabs over one page rather than two pages.
 *
 *   Live     the pool: what the agents are actually carrying
 *   Pending  the queue, for working through it — opened first when something waits on you
 *   Explore  skills somebody else wrote
 *
 * There was an All tab, pending then the pool; with nothing pending it showed exactly what Live did, so switching
 * between them looked like a tab that did nothing. The dials sit above the tabs; each list scrolls inside its card,
 * which fills the window (`fillsViewport`), so the tabs stay put however long the list.
 */

import { ListLoading } from "@/commons/components/ui/Spinner";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { PoolList } from "./pool.list";
import { DecidedStrip, DraftList } from "./drafts.panel";
import { LearningSettingsPanel } from "./learning-settings";
import { ExplorePanel } from "./explore.panel";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

type Tab = "live" | "pending" | "explore";

export default function SkillWorkshopPage() {
  const me = useMe();
  const catalog = useQuery({ queryKey: ["skill-catalog"], queryFn: api.skillCatalog, retry: false });
  const drafts = useQuery({ queryKey: ["skill-drafts"], queryFn: api.skillDrafts, retry: false });

  // Pending first when something waits on you; the pool otherwise.
  const [chosen, setTab] = useState<Tab | null>(null);
  // One filter per list, in the list's own header: on All both are showing, and a filter that
  // narrowed one while you looked at the other would hide what you were looking for.
  const [pendingQuery, setPendingQuery] = useState("");
  const [poolQuery, setPoolQuery] = useState("");

  const skills = catalog.data?.skills ?? [];
  const pending = drafts.data?.pending ?? [];
  const tab: Tab = chosen ?? (pending.length > 0 ? "pending" : "live");
  const decided = drafts.data?.recent ?? [];
  const editable = Boolean(catalog.data?.editable) && canWrite(me.data ?? null);

  const visibleSkills = useTextFilter(skills, poolQuery, (skill) => [skill.name, skill.description]);
  const visiblePending = useTextFilter(pending, pendingQuery, (draft) => [draft.name, draft.description, draft.triggerReason, draft.agentId]);

  if (catalog.isPending) {
    return <ListLoading />;
  }

  const showPending = tab === "pending";
  const explore = tab === "explore" ? <ExplorePanel editable={editable} onReview={() => setTab("pending")} /> : null;
  const showPool = tab === "live";

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        ask={PAGE_ASKS.skills}
        pose={catalog.isPending || skills.length > 0 ? "star" : undefined}
        title="Skills Workshop"
        description="One pool of skills, shared by every agent. Each agent holds a switch; nothing here is copied per agent."
      />

      <ErrorNote error={catalog.error} />

      <LearningSettingsPanel canEdit={canWrite(me.data ?? null)} onShowPending={() => setTab("pending")} />

      <SegmentedTabs
        tabs={[
          { value: "live" as Tab, label: "Live", after: <Count n={skills.length} /> },
          // The only count worth colouring: it is the one that means somebody has to do something.
          { value: "pending" as Tab, label: "Pending", after: <Count n={pending.length} highlight={pending.length > 0} /> },
          // Skills somebody else wrote. Installing one lands it on Pending, so it sits beside it.
          { value: "explore" as Tab, label: "Explore" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {explore}

      {showPending ? (
        <ScrollCard
          fill
          title={`${pending.length} draft${pending.length === 1 ? "" : "s"} waiting on you`}
          description="Skills an agent worked out, or you fetched from a hub. Approving one puts it in the pool for every agent; nothing expires."
          {...(pending.length > 0 ? { search: { value: pendingQuery, onChange: setPendingQuery, placeholder: "Filter drafts" } } : {})}
        >
          <ErrorNote error={drafts.error} />
          {drafts.isPending ? (
            <ListLoading />
          ) : pending.length === 0 ? (
            <EmptyState
              icon={Lightbulb}
              title="Nothing waiting"
              description="An agent drafts a skill after a turn that took real working out, or when you ask it to in so many words."
            />
          ) : visiblePending.length === 0 ? (
            <p className="py-6 text-center text-sm text-base-content/65">No draft matches “{pendingQuery}”.</p>
          ) : (
            <DraftList drafts={visiblePending} editable={editable} />
          )}
          <DecidedStrip drafts={decided.slice(0, 5)} />
        </ScrollCard>
      ) : null}

      {showPool ? (
        <ScrollCard
          fill
          title={`${skills.length} skill${skills.length === 1 ? "" : "s"} live`}
          {...(skills.length > 0 ? { search: { value: poolQuery, onChange: setPoolQuery, placeholder: "Filter skills" } } : {})}
        >
          {skills.length === 0 ? (
            <EmptyState
              pose="star"
              title="The pool is empty"
              description="An agent writes one when it works out how to do something, or you can find one on the Explore tab."
            />
          ) : visibleSkills.length === 0 ? (
            <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{poolQuery}”.</p>
          ) : (
            <PoolList skills={visibleSkills} editable={editable} />
          )}
          {/* Where the pool is kept, for whoever runs the server (0.8.19): it was the card's description. */}
          {catalog.data?.poolDir ? (
            <Details className="mt-3">
              <p className="break-all font-mono">{catalog.data.poolDir}</p>
            </Details>
          ) : null}
        </ScrollCard>
      ) : null}
    </div>
  );
}
