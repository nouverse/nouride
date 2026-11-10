/**
 * `/mention` — whether a message in this group needs a mention to be answered, set from the group.
 *
 * `groups_require_mention` was a line in `config.toml`: daemon-wide, or per connection. A group that wanted the other
 * answer had to get someone to the box. This is the group's own value, stored for the group as the platform sees it
 * (`pipeline/room-mention.store.ts`), so every one of our bots in it reads the same thing.
 *
 * Reading it is anyone's; changing it is an admin's, the same check `/daemon-restart` and `/secret` make — a chat
 * sender is not authenticated, and this decides whether the bots answer everybody in the room. A DM is refused before
 * anything is stored: a DM always gets an answer, so there is nothing to set.
 *
 * Every bot in the group is handed the command. It is answered before routing on the bot it arrived on
 * (`aboutTheGroup`), and only the first copy does anything (`firstCopy`): one change, one answer.
 */

import type { Hook, HookContext, MentionSource } from "../types.ts";
import { isPlatformMention } from "../parse.ts";

const DM_REFUSAL = "/mention only works in a group. A DM always gets an answer, no mention needed.";
const NOT_ADMIN = "Only an admin can change this for the group.";
const USAGE = "`/mention` shows this group's setting · `/mention off` no mention needed · `/mention on` mention required · `/mention default` follow the gateway or daemon again";

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

const sentence = (requireMention: boolean) =>
  requireMention ? "In this group a mention is required." : "In this group no mention is needed.";

const mention: Hook = {
  command: "/mention",
  description: "Whether this group needs a mention: `/mention`, `/mention off`, `/mention on`, `/mention default`",
  // The group's setting, not this agent's: pausing the agent that happens to receive it has nothing to say about it.
  worksWhilePaused: true,
  aboutTheGroup: true,
  handler: async (ctx) => ({ handled: true, ...reply(ctx) }),
};

function reply(ctx: HookContext): { reply?: string } {
  const port = ctx.deps.groupMention;
  if (ctx.envelope.chatType === "dm") return { reply: DM_REFUSAL };
  if (!port) return { reply: "A group's own mention setting is not available on this daemon." };
  // A trailing tag of the bot it was sent to is not an argument — `/mention off <@123>` on Discord.
  const args = ctx.args.filter((arg) => !isPlatformMention(arg)).map((arg) => arg.toLowerCase());
  // Every bot in the group got this message; the first copy answers it, the rest say nothing.
  if (!port.firstCopy(ctx.envelope, ["/mention", ...args].join(" "))) return {};

  const word = args[0] ?? "";
  if (!word) {
    const here = port.here(ctx.envelope);
    return { reply: `${sentence(here.requireMention)} (${FROM[here.source]})\n${USAGE}` };
  }
  const wanted = word === "on" ? true : word === "off" ? false : word === "default" ? null : undefined;
  if (wanted === undefined) return { reply: USAGE };
  if (!port.mayChange(ctx.envelope)) return { reply: NOT_ADMIN };

  const removed = port.set(ctx.envelope, wanted, `${ctx.gatewayId}:${ctx.senderId}`);
  const now = port.here(ctx.envelope);
  if (wanted !== null) return { reply: `Done. ${sentence(now.requireMention)}` };
  return {
    reply: `${removed ? `Done. This group follows ${FOLLOWS[now.source]} again.` : `This group had no setting of its own; it follows ${FOLLOWS[now.source]}.`} ${sentence(now.requireMention)}`,
  };
}

export const mentionHooks: Hook[] = [mention];
