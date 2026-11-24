/**
 * A fact about the person speaking, kept, corrected or dropped by the agent they are talking to: `memory_write` with
 * about=person. Its own file since a fact can be kept to its person's direct chats: what is written, which facts a
 * turn may touch, and what the agent is told about where the fact is read are one decision.
 *
 * What is written is stamped with this chat's audience, so it is readable where this conversation is, and where its
 * person speaks (`followsItsPerson`) unless they keep it to their direct chats. A fact to correct or drop is named by
 * its words, and only one this turn reads can be touched.
 */

import { oneLine } from "@nouride/shared";
import { canSeeFact, followsItsPerson, type Audience } from "./access.ts";
import type { Fact, FactOperation } from "./profile.ts";
import { editProfile, type ProfileWrites } from "./write.ts";

/**
 * Where a fact just kept about a person is read, for the agent to say: `said` is the kind of chat it was said in,
 * `directOnly` that its person kept it to their direct chats, `follows` that it is read wherever they speak. The agent
 * guessed before, and told a person their fact was this one chat's.
 */
export interface FactReach {
  said: "direct" | "group";
  directOnly: boolean;
  follows: boolean;
}

export type OwnFactChange =
  | { op: "add"; section: string; text: string; direct?: boolean }
  | { op: "update"; current: string; text: string; direct?: boolean }
  | { op: "remove"; current: string };

const NO_PROFILE = "The person you are talking to has no profile yet. If you know their name, record them with `person_record` first, then call this again. If you do not, keep it only for this conversation: do not put it in MEMORY.md.";
const SAID_IN_A_GROUP = "This was said in a group, so the group has read it: a fact is kept to someone's direct chats from a direct chat with them. Say so, and do it there when they write to you.";

export async function noteOwnFact(
  deps: ProfileWrites,
  who: { person: { key: string; name: string } | null; identity: string; audience: Audience; /** `[memory] private_in_groups`. */ brings: boolean },
  change: OwnFactChange,
): Promise<{ status: "written" | "unchanged"; reach: FactReach } | { refused: string }> {
  const { person, identity, audience, brings } = who;
  if (!person) return { refused: NO_PROFILE };
  const asksDirect = change.op !== "remove" && change.direct === true;
  if (asksDirect && audience.kind === "group") return { refused: SAID_IN_A_GROUP };
  const reads = (fact: Fact) => canSeeFact(fact, person.key, audience) || (brings && followsItsPerson(fact, person.key, audience));
  const same = (a: string, b: string) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();
  // Decided as the profile is read, under its lock: a correction keeps the mark its fact had unless it says otherwise.
  let direct = asksDirect;
  const result = await editProfile(deps, person.key, {
    operations: (facts): FactOperation[] | { refused: string } => {
      if (change.op === "add") return [change];
      const fact = facts.find((candidate) => same(candidate.text, change.current) && reads(candidate));
      if (!fact) return { refused: `No fact reading "${change.current}" is known here. Use the words exactly as they appear under what you know about them.` };
      if (change.op === "update" && audience.kind === "dm") direct = change.direct ?? fact.readers?.direct === true;
      return [change.op === "update" ? { op: "update", n: fact.n, text: change.text } : { op: "remove", n: fact.n }];
    },
    provenance: () => ({ readers: audience.kind === "dm" ? { people: [identity], ...(direct ? { direct: true as const } : {}) } : { people: [...audience.present], chat: audience.chat } }),
    cause: "agent",
    name: person.name,
  });
  if (result.status === "refused") return { refused: result.reason };
  return { status: result.status, reach: { said: audience.kind === "dm" ? "direct" : "group", directOnly: direct, follows: brings && !direct } };
}
