/**
 * The missions a list shows, as cards in the Knowledge tab's grid. The reader's own are under what a person does about
 * them: needs you, working, finished. Where an admin reads someone else's they are under whose they are instead, each
 * card saying how it stands.
 *
 * Drawn from what the daemon sent rather than what the search left: a mission that changes state leaves its group and
 * enters the next, and one the search hides only is not drawn (`shown`), so typing moves nothing. Kept drawn while the
 * tab is empty, showing `empty` once nothing is left to draw, so it sees the first mission arrive.
 */

import type { ReactNode } from "react";
import type { MissionView } from "@nouride/wire";
import { PersonSection } from "@/commons/components/people/PersonSection";
import { CardGrid } from "@/commons/components/ui/CardGrid";
import { useMotionList, type Moving } from "@/commons/hooks/use-motion-list";
import { byPerson } from "@/commons/lib/by-person";
import { grouped, tabOf, type MissionTab } from "../lib/mission";
import { MissionCard } from "./MissionCard";

interface Listed {
  missions: MissionView[];
  tab: MissionTab;
  shown: (mission: MissionView) => boolean;
  empty: ReactNode;
}

const key = (mission: MissionView) => mission.id;

export function MissionList({ missions, tab, shown, empty }: Listed) {
  const groups = grouped(missions);
  const needsYou = useMotionList(groups.needsYou, key, { shown });
  const working = useMotionList(groups.working, key, { shown });
  const finished = useMotionList(groups.finished, key, { shown });
  const inTab = useMotionList(missions.filter((mission) => tabOf(mission) === tab), key, { shown });
  if (tab !== "all") return inTab.length === 0 ? empty : <Cards cards={inTab} />;
  if (needsYou.length + working.length + finished.length === 0) return empty;
  return (
    <div className="space-y-7">
      <Group title="Needs you" cards={needsYou} count={groups.needsYou.filter(shown).length} />
      <Group title="Working" cards={working} count={groups.working.filter(shown).length} />
      <Group title="Finished" cards={finished} count={groups.finished.filter(shown).length} />
    </div>
  );
}

/** Set apart by person, in the daemon's order within each: `first` is the key of the person whose come first. */
export function MissionsByPerson({ missions, tab, shown, empty, first }: Listed & { first: string | undefined }) {
  const inTab = useMotionList(tab === "all" ? missions : missions.filter((mission) => tabOf(mission) === tab), key, { shown });
  if (inTab.length === 0) return empty;
  return (
    <div className="space-y-7">
      {byPerson(inTab, (one) => one.item.person, first).map((group) => (
        <PersonSection key={group.key} label={group.label} count={group.items.length}>
          <Cards cards={group.items} />
        </PersonSection>
      ))}
    </div>
  );
}

function Group({ title, cards, count }: { title: string; cards: Moving<MissionView>[]; count: number }) {
  if (cards.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2.5">
      <h3 className="px-1 font-mono text-[11px] font-bold uppercase tracking-wider text-base-content/65">
        {title} <span className="font-normal">· {count}</span>
      </h3>
      <Cards cards={cards} />
    </section>
  );
}

/** The missions as cards, in the Knowledge tab's grid. */
function Cards({ cards }: { cards: Moving<MissionView>[] }) {
  return (
    <CardGrid>
      {cards.map(({ key, item, motion }) => (
        <MissionCard key={key} mission={item} motion={motion} />
      ))}
    </CardGrid>
  );
}
