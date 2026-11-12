/**
 * `/secret` — the credentials people send in chat, from the chat.
 *
 * The daemon takes a credential out of a message as it arrives and holds it under a handle for an hour
 * (`pipeline/chat-secrets.ts`). Here a person sees what this conversation holds, keeps one under a name for good, and
 * puts back a message the daemon took something from that was not a secret. The secret guard has no switch here since
 * 0.8.0: it asks at every approval level but `trusted`.
 *
 * Keeping a value under a name is an admin's — paired or on an allowlist, and under People the same person as an
 * admin's dashboard account, as for `/daemon-restart`: the secret store is the daemon's rather than this chat's. Anyone
 * may see what is held and put their own message back.
 */

import type { Hook, HookContext } from "../types.ts";

const USAGE = [
  "`/secret set <name> <value>`: keep a value under a name, for good (admins)",
  "`/secret replace <name> <value>`: the same, over a name already set (admins)",
  "`/secret undo`: your last message the daemon took something from, back as you wrote it",
].join("\n");

const ADMIN =
  "an admin: someone paired with me whose person, under People, is linked to an admin's dashboard account. The dashboard's Secrets page can too.";

const secret: Hook = {
  command: "/secret",
  description: "Credentials sent here: `/secret`, `/secret set <name> <value>`, `/secret undo`",
  // Nothing here runs the agent: what is held, and the store, are the daemon's.
  worksWhilePaused: true,
  // In a group it is about the group's messages, whichever bot was handed them: typed with no tag in a room several
  // of our bots share it reached nobody, and "put my message back" went unanswered.
  aboutTheGroup: "group",
  handler: async (ctx) => {
    const port = ctx.deps.secrets;
    if (!port) return { handled: true, reply: "This daemon does not take credentials out of messages." };
    // Every bot in a group is handed the command: the first copy answers, the rest say nothing and put nothing back.
    if (ctx.envelope.chatType !== "dm" && ctx.deps.groupMention && !ctx.deps.groupMention.firstCopy(ctx.envelope, ["/secret", ...ctx.args].join(" "))) return { handled: true };
    const [verb = "", ...rest] = ctx.args;
    switch (verb.toLowerCase()) {
      case "":
      case "help":
        return { handled: true, reply: status(ctx) };
      case "set":
      case "replace":
        return { handled: true, reply: await keep(ctx, verb.toLowerCase() === "replace", rest) };
      case "undo":
        return {
          handled: true,
          reply: port.putBack(ctx.envelope, rest[0])
            ? "Put back as you wrote it. I'll read it again."
            : "Nothing of yours was taken out of a message here in the last 15 minutes.",
        };
      default:
        return { handled: true, reply: `No \`/secret ${verb}\`.\n\n${USAGE}` };
    }
  },
};

function status(ctx: HookContext): string {
  const port = ctx.deps.secrets!;
  // The message's own conversation: in a room, the room's handles (`secretScope`).
  const held = port.held(ctx.envelope);
  const lines = held.length
    ? ["Held in this chat, each for an hour after it was sent:", ...held.map((secret) => `• ${secret.handle}: ${secret.label}, ${secret.minutesLeft} min left`)]
    : ["Nothing held in this chat."];
  return [...lines, "", USAGE].join("\n");
}

async function keep(ctx: HookContext, replace: boolean, rest: string[]): Promise<string> {
  const port = ctx.deps.secrets!;
  const [name, handle] = rest;
  if (!name || !handle) return `Say the name and the value: \`/secret ${replace ? "replace" : "set"} <name> <value>\`.`;
  if (!port.mayManage(ctx.envelope)) return `Only ${ADMIN}`;
  const outcome = await port.keep({ name, handle, where: ctx.envelope, replace, actor: `${ctx.gatewayId}:${ctx.senderId}`, agentId: ctx.agent.config.id });
  switch (outcome.status) {
    case "kept":
    case "replaced": {
      const done = outcome.status === "kept" ? `Kept as \`${name}\`.` : `Replaced the value of \`${name}\`.`;
      const agent = ctx.agent.config.id;
      if (!("variable" in outcome.handed)) return `${done} Not handed to ${agent}'s commands: ${outcome.handed.error}`;
      return outcome.handed.already
        ? `${done} ${agent}'s config.toml already says which commands get it, as ${outcome.handed.variable}.`
        : `${done} Every command of ${agent}'s gets it as ${outcome.handed.variable}; narrow that under \`[security.exec_secrets]\` in its config.toml.`;
    }
    case "exists":
      return `\`${name}\` is already set. \`/secret replace ${name} <value>\` replaces it.`;
    case "gone":
      return "That value is no longer held here. Send the command again.";
    case "invalid":
      return outcome.error;
  }
}

export const secretHooks: Hook[] = [secret];
