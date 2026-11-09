/**
 * What every prompt carries without being asked — `docs/SPEC.md` §12.3.
 *
 * - The profile of each known person in the chat — in a DM its person, in a group those speaking in
 *   it — as far as this audience may read it. 60 facts a person and 120 in all: in a big group everyone
 *   present gets the same share, in the order of their keys, whoever is speaking (below).
 * - `shared.md`, which every agent knows in every chat.
 * - The newest episode summaries this audience may see, each saying when it was another agent's, so
 *   an agent never claims a conversation it did not have.
 * - The conversations cut since the last pass — after `/new`, the one just left — by the first thing
 *   said in each, with the id `memory_read` opens. Without them a new session knew nothing of the
 *   last one until the night had filed it, unless the agent thought to search.
 *
 * - What is coming in the next week — a fact's `(on …)` date — and each person's open follow-ups,
 *   out of the profile and listed on their own so the fact cap never hides a promise. A fact whose
 *   `(until …)` day has passed is not shown at all (`fact-dates.ts`).
 *
 * **Off where a person asked** (`[memory] recall`, and a `[[people]]` entry's own over it): their facts are left out,
 * and a chat whose RECALL is off — a DM follows its person, a group the setting — carries no shared knowledge and no
 * conversations either. The pass still learns, and the tools still reach all of it.
 *
 * `memory_search` reaches the rest. Nothing here changes between a cut and the next — a `/new`, or
 * the nightly pass — except the day, once, at midnight, a fact written now, and in a group who has
 * been speaking lately; so it is a cached block of its own, after the harness (`llm/prompt/index.ts`).
 *
 * **Never in the order people spoke.** It was: the speaker first and in full, the rest in the order
 * they appear in the room's last 30 messages. So in a group every turn whose speaker was not the last
 * one's rewrote these bytes, and everything the cache held behind them went with them. Measured on the
 * x64 test box over two weeks of `llm_usage`: the first call of a group turn after a change of speaker
 * had a median of 41% of its input cached (6 turns), against 73% when the same person spoke again (20)
 * and 96% in a DM (820). Profiles are in key order now, and each one's share depends only on how many
 * facts everyone present has, so a change of speaker changes nothing here. What that costs: in a group
 * of three or more with long profiles, the one speaking no longer gets theirs in full — `memory_search`
 * reaches the rest, and the harness says to search before saying you do not recall.
 */

import type { Person } from "@nouride/shared";
import { canSeeFact, scopeOf, type Audience } from "./access.ts";
import { localTime } from "@/commons/clock.ts";
import { comingOn, FOLLOW_UPS, isOver } from "./fact-dates.ts";
import type { IndexedFact, MemoryIndexPort } from "./memory-index.store.ts";
import { isKey, nameOf, recallOn } from "./people.ts";
import { oncePerMeaning } from "./same-fact.ts";
import { episodeDay, SHARED } from "./vault.ts";

export interface RecalledFact {
  section: string;
  text: string;
  /** The day it was learned, so a plan or a job search can be judged stale. None for a fact written by hand. */
  learned?: string;
}

export interface Recall {
  profiles: { name: string; facts: RecalledFact[] }[];
  shared: RecalledFact[];
  /** Dated facts falling in the next week, soonest first. */
  upcoming: { name: string | null; text: string; day: string }[];
  /** What each person here is waiting on, or asked to be reminded of. */
  followUps: { name: string; text: string; learned?: string }[];
  /** Filed and summarized, with the id `memory_read` opens — the prompt tells the model to open these. */
  recent: { id: string; day: string; time: string; agents: string[]; summary: string; theirs: boolean }[];
  /** Cut and not filed yet: what was said first, and the id to read the rest. */
  waiting: { id: string; day: string; time: string; agents: string[]; preview: string; theirs: boolean }[];
  /** The knowledge collections this agent may search in this chat (0.8.20), by name: what is in them is searched for. */
  knowledge?: { name: string; description: string; about?: string[] }[];
}

/** Facts of one person shown per prompt — past it, `memory_search` finds the rest. */
const MAX_FACTS_PER_PERSON = 60;
/** Facts shown across everyone here — a group of fifteen would otherwise carry 900. */
const MAX_FACTS_IN_PROMPT = 120;
/** How far ahead a dated fact is brought up. */
const UPCOMING_DAYS = 7;
const MAX_FOLLOW_UPS = 10;

function learned(fact: IndexedFact): { learned?: string } {
  const day = episodeDay(fact.source);
  return day ? { learned: day } : {};
}

const recalled = (fact: IndexedFact): RecalledFact => ({ section: fact.section, text: fact.text, ...learned(fact) });

export function recallFor(input: {
  index: MemoryIndexPort;
  people: readonly Person[];
  audience: Audience;
  agentId: string;
  recent: number;
  timeZone: string;
  now?: number;
  /** Facts' vectors by fact id, when search by meaning is on — what tells two facts that say the same thing apart. */
  vectors?: ReadonlyMap<string, Int8Array>;
  /** `[memory] recall`; absent is on, the default. */
  recall?: boolean;
}): Recall {
  const { index, audience } = input;
  const today = localTime(input.now ?? Date.now(), input.timeZone).day;
  const present = audience.kind === "dm" ? [audience.person] : audience.present;
  const settings = { memory: { recall: input.recall ?? true }, people: input.people };
  const chatOn = audience.kind === "dm" && isKey(audience.person) ? recallOn(settings, audience.person) : settings.memory.recall;
  // By key, whatever order the audience lists them in: the speaker first, then by who spoke last.
  const subjects = [...new Set(present.filter(isKey))].filter((subject) => recallOn(settings, subject)).sort();
  const facts = index.facts(subjects).filter((fact) => !isOver(fact.text, today));
  // Each meaning once: the same fact learned in several chats is a line for each (`same-fact.ts`).
  const readable = subjects.map((subject) => ({
    name: nameOf(input.people, subject),
    facts: oncePerMeaning(
      facts.filter((fact) => fact.subject === subject && canSeeFact(fact, subject, audience)),
      input.vectors,
    ),
  }));

  const known = readable.map((person) => ({ name: person.name, facts: person.facts.filter((fact) => fact.section !== FOLLOW_UPS) })).filter((profile) => profile.facts.length > 0);
  const shares = shareOut(
    known.map((profile) => profile.facts.length),
    MAX_FACTS_PER_PERSON,
    MAX_FACTS_IN_PROMPT,
  );
  const profiles = known.map((profile, i) => ({
    name: profile.name,
    facts: profile.facts.slice(0, shares[i]).map(recalled),
  }));

  // Not collapsed: a shared fact is one line a person approved, and its twins are caught before they are (`proposals.ts`).
  const shared = chatOn
    ? index
        .facts([SHARED])
        .filter((fact) => !isOver(fact.text, today))
        .map(recalled)
    : [];

  const dated: { name: string | null; text: string }[] = [
    ...readable.flatMap((person) => person.facts.map((fact) => ({ name: person.name, text: fact.text }))),
    ...shared.map((fact) => ({ name: null, text: fact.text })),
  ];
  const upcoming = dated
    .flatMap((fact) => {
      const day = comingOn(fact.text, today, UPCOMING_DAYS);
      return day ? [{ ...fact, day }] : [];
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  const followUps = readable
    .flatMap((person) => person.facts.filter((fact) => fact.section === FOLLOW_UPS).map((fact) => ({ name: person.name, text: fact.text, ...learned(fact) })))
    .slice(0, MAX_FOLLOW_UPS);

  const recent =
    chatOn && input.recent > 0
      ? index
          .episodes({ scope: scopeOf(audience), statuses: ["summarized", "compacted"] }, input.recent)
          .filter((episode) => episode.summary)
          .map((episode) => ({
            id: episode.id,
            day: episode.day,
            time: localTime(episode.startedAt, input.timeZone).time,
            agents: episode.agents,
            summary: episode.summary!,
            theirs: episode.agents.length > 0 && !episode.agents.includes(input.agentId),
          }))
      : [];

  const waiting =
    chatOn && input.recent > 0
      ? index
          .episodes({ scope: scopeOf(audience), statuses: ["raw"] }, input.recent)
          .filter((episode) => episode.preview)
          .map((episode) => ({
            id: episode.id,
            day: episode.day,
            time: localTime(episode.startedAt, input.timeZone).time,
            agents: episode.agents,
            preview: episode.preview!,
            theirs: episode.agents.length > 0 && !episode.agents.includes(input.agentId),
          }))
      : [];

  return { profiles, shared, upcoming, followUps, recent, waiting };
}

/**
 * How many facts each profile shows: up to `each`, and `total` split evenly when that would pass it, a small profile's
 * unused share going to the others. No profile is first: the smallest are served first, and of two the same size the
 * later in key order takes what does not divide — so the shares follow from the sizes, never from who is speaking.
 */
function shareOut(sizes: readonly number[], each: number, total: number): number[] {
  const shares = sizes.map(() => 0);
  const order = sizes.map((size, i) => ({ size: Math.min(size, each), i })).sort((a, b) => a.size - b.size || a.i - b.i);
  let left = total;
  order.forEach(({ size, i }, n) => {
    shares[i] = Math.min(size, Math.floor(left / (order.length - n)));
    left -= shares[i]!;
  });
  return shares;
}
