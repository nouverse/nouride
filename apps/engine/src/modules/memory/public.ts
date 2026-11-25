/**
 * Memory as an agent open to everyone reads it: nothing of a person's, whoever is asking.
 *
 * An open agent answers anybody who finds it, so what it may read is decided for the agent and never by the sender.
 * An admin who writes to their own open bot gets the public's answers: a bot that knew more for some senders could be
 * made to say it to others, and what it must not say would then be a matter of its model's care.
 *
 * Its reads are made as nobody: an identity no fact, no conversation and no collection names, in a direct chat no
 * conversation was ever filed under. Asked that way, the rules every read already follows give it what is everyone's
 * and nothing else: a collection whose readers are everyone is its to search, a person's facts and conversations are
 * not there. What those rules do not decide by who is asking (the shared knowledge every chat is given) is left out
 * by hand, in `publicRecall`.
 */

import type { Audience } from "./access.ts";
import type { ChatSource } from "./cut.ts";
import type { Recall } from "./recall.ts";

/** Who an open agent's reads are made as. A colon, so never a person's key; `public`, which no connection is called. */
export function nobody(agentId: string): string {
  return `public:${agentId}`;
}

/** The chat an open agent reads from, as memory judges it: one to one, with nobody. */
export function publicAudience(agentId: string): Audience {
  return { kind: "dm", chat: nobody(agentId), person: nobody(agentId) };
}

/** What an open agent's prompt is given of memory: the collections it may search, by name, and nothing else. */
export function publicRecall(knowledge: NonNullable<Recall["knowledge"]>): Recall {
  return { profiles: [], shared: [], upcoming: [], followUps: [], recent: [], waiting: [], knowledge };
}

/** Said to a call that would write, should one ever reach memory for an open agent: it holds no tool that does. */
export const PUBLIC_KEEPS_NOTHING = "This agent is open to everyone and keeps nothing a chat tells it.";

/**
 * A chat's log without what an agent open to everyone was asked and answered: its conversations make no episode, so
 * what one stranger said is neither filed nor read by the nightly pass, and never becomes what any agent remembers.
 * A chat that only such an agent answered in then has nothing to cut.
 *
 * By the exchange's own mark, set as its turn began, and by what the agent is now. The mark is what holds once the
 * agent is closed, deleted or no longer loads: by the agent alone, the next pass after any of those filed every
 * conversation it had had with strangers.
 */
export function withoutPublic<Source extends Pick<ChatSource, "exchangesBetween">>(source: Source, isPublic: (agentId: string) => boolean): Source {
  const exchangesBetween: ChatSource["exchangesBetween"] = (...window) => source.exchangesBetween(...window).filter((exchange) => exchange.public !== true && !isPublic(exchange.agentId));
  return Object.assign(Object.create(source) as Source, { exchangesBetween });
}
