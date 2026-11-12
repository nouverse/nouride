/**
 * `/mention` — a message in this group that tags nobody: who answers it? Set from the group.
 *
 * One setting, because it is one question. `groups_require_mention` was a line in `config.toml`, daemon-wide or per
 * connection, and a group that wanted the other answer had to get someone to the box; then `/mention on` and `off`
 * said it from the group. What nothing said from the group was *which* agent: a topic meant for one agent was the
 * orchestrator's all the same, unless somebody wrote a channel binding for it under every bot's connection in a file.
 * So the setting has three answers: a tag is needed (`required`), or none is and the agent named answers
 * (`/mention <agent>`), or the group says nothing of its own (`default`).
 *
 * It is the group's own value, stored for the group as the platform sees it (`pipeline/room-mention.store.ts`), so
 * every one of our bots in it reads the same thing.
 *
 * Reading it is anyone's; changing it is an admin's, the same check `/daemon-restart` and `/secret` make — a chat
 * sender is not authenticated, and this decides whether the bots answer everybody in the room. A DM is refused before
 * anything is stored: a DM always gets an answer, so there is nothing to set.
 *
 * Every bot in the group is handed the command. It is answered before routing on the bot it arrived on
 * (`aboutTheGroup`), and only the first copy does anything (`firstCopy`): one change, one answer.
 *
 * `on` and `off` are still read: installs use them. `on` is `required`; `off` is no tag needed with nobody named, which
 * is the orchestrator's to answer. Neither is taught, and the answer is always in the words above.
 */

import type { Hook, HookContext, MentionSource } from "../types.ts";
import { isPlatformMention } from "../parse.ts";

const DM_REFUSAL = "/mention only works in a group. A DM always gets an answer, no tag needed.";
const NOT_ADMIN = "Only an admin can change this for the group.";
const USAGE =
  "`/mention` shows who answers here · `/mention <agent>` that agent answers every message that tags nobody · `/mention required` a tag is needed · `/mention default` follow the gateway or daemon again";

const FROM: Record<MentionSource, string> = {
  group: "set for this group with /mention",
  gateway: "from the gateway's `groups_require_mention`",
  daemon: "from the daemon's `[agents] groups_require_mention`",
  room: "a room made in the dashboard: the orchestrator answers when it is in the room, or the room's only agent",
};

/** What a group follows once its own setting is gone, as `/mention default` says it. */
const FOLLOWS: Record<MentionSource, string> = {
  group: "its own setting",
  gateway: "the gateway",
  daemon: "the daemon",
  room: "the room's own rule",
};

type Agents = ReturnType<NonNullable<HookContext["deps"]["groupMention"]>["agents"]>;
type Here = ReturnType<NonNullable<HookContext["deps"]["groupMention"]>["here"]>;

const nameOf = (agents: Agents, id: string): string => agents.find((agent) => agent.id === id)?.name ?? id;

/** Both halves in one sentence: whether a tag is needed, and who answers a message that carries none. */
function sentence(here: Here, agents: Agents): string {
  if (here.requireMention) return "Here a tag is needed: a message that tags nobody is answered by nobody.";
  const gone = here.gone ? ` ${nameOf(agents, here.gone)}, the agent named for it, is no longer here.` : "";
  if (here.answers) return `Here no tag is needed; ${nameOf(agents, here.answers)} answers.${gone}`;
  return `Here no tag is needed, and nobody answers a message that tags nobody: name an agent with \`/mention <agent>\`.${gone}`;
}

/** The agent a person named, by any of the forms a tag takes: its bot's handle, its id, its name, a platform's tag. */
function named(agents: Agents, words: string): Agents[number] | undefined {
  const plain = (text: string) => text.trim().toLowerCase().replace(/^@/, "");
  const wanted = plain(words);
  return agents.find((agent) => [agent.id, agent.name, ...(agent.tag ? [agent.tag] : [])].some((form) => plain(form) === wanted));
}

const listed = (agents: Agents): string => agents.map((agent) => (agent.tag && agent.tag.startsWith("@") ? `${agent.name} (${agent.tag})` : agent.name)).join(", ");

const mention: Hook = {
  command: "/mention",
  description: "Who answers here without a tag: `/mention`, `/mention <agent>`, `/mention required`, `/mention default`",
  // The group's setting, not this agent's: pausing the agent that happens to receive it has nothing to say about it.
  worksWhilePaused: true,
  aboutTheGroup: true,
  handler: async (ctx) => ({ handled: true, ...reply(ctx) }),
};

function reply(ctx: HookContext): { reply?: string } {
  const port = ctx.deps.groupMention;
  if (ctx.envelope.chatType === "dm") return { reply: DM_REFUSAL };
  if (!port) return { reply: "A group's own mention setting is not available on this daemon." };
  const words = ctx.args.join(" ").trim();
  const first = (ctx.args[0] ?? "").toLowerCase();
  // One of the setting's own words, and what follows it is not an argument: a trailing tag of the bot it was sent
  // to, `/mention required <@123>` on Discord. Anything else is an agent's name, a tag among its forms.
  const keyword = ["required", "default", "on", "off"].includes(first) && ctx.args.slice(1).every(isPlatformMention) ? first : "";
  // Every bot in the group got this message; the first copy answers it, the rest say nothing.
  if (!port.firstCopy(ctx.envelope, ["/mention", keyword || words.toLowerCase()].join(" ").trim())) return {};

  const agents = port.agents(ctx.envelope);
  if (!words) {
    const here = port.here(ctx.envelope);
    // Addressed to one bot and saying nothing else, as a command menu writes it: that bot's agent answers (`addressedHere`),
    // and says how the room is given to it. The person who sent it meant that.
    const mine = agents.find((agent) => agent.id === ctx.agent.config.id);
    const teach = ctx.envelope.mentionsSelf && mine && here.answers !== mine.id ? `\nTo have ${mine.name} answer everything here: \`/mention ${mine.tag ?? mine.id}\`.` : "";
    return { reply: `${sentence(here, agents)} (${FROM[here.source]})${teach}\n${USAGE}` };
  }

  const agent = keyword ? undefined : named(agents, words);
  if (!keyword && !agent) return { reply: `No agent here is called "${words}". The agents: ${listed(agents)}.\n${USAGE}` };
  if (!port.mayChange(ctx.envelope)) return { reply: NOT_ADMIN };

  const actor = `${ctx.gatewayId}:${ctx.senderId}`;
  if (keyword === "default") {
    const removed = port.set(ctx.envelope, null, actor);
    const now = port.here(ctx.envelope);
    return {
      reply: `${removed ? `Done. This group follows ${FOLLOWS[now.source]} again.` : `This group had no setting of its own; it follows ${FOLLOWS[now.source]}.`} ${sentence(now, agents)}`,
    };
  }
  port.set(ctx.envelope, keyword === "required" || keyword === "on" ? { requireMention: true } : { requireMention: false, ...(agent ? { answerer: agent.id } : {}) }, actor);
  return { reply: `Done. ${sentence(port.here(ctx.envelope), agents)}` };
}

export const mentionHooks: Hook[] = [mention];
