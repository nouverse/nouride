/**
 * The two commands about the commands: the help list, and pushing that list into a platform's own
 * slash-command menu.
 */

import { plural } from "@nouride/shared";
import { failed, titled, uses } from "../format.ts";
import type { Hook } from "../types.ts";

/**
 * How `/help` groups the commands, in the order a person looks for them. A command in no group is listed under "More",
 * so one added later is never left out: the list was typed by hand once, and by the time it was read it lacked
 * `/mission`, `/effort`, `/notes`, `/sleep` and six more that all answered.
 */
export const HELP_GROUPS: readonly (readonly [title: string, commands: readonly string[]])[] = [
  ["This conversation", ["/new", "/compact", "/reset", "/notes", "/btw", "/status"]],
  ["This agent", ["/sleep", "/wake", "/start", "/stop", "/model", "/effort", "/agents", "/reload", "/prompt"]],
  ["Work it carries on", ["/mission", "/helpers", "/backgrounds", "/schedule", "/drafts"]],
  ["What it asks before it acts", ["/approvals", "/approve", "/deny", "/grants"]],
  ["For admins", ["/secret", "/mention", "/daemon-restart", "/commands"]],
];

/** The help list (pure): each command with what it says of itself, a group to a block, a blank line between blocks. */
export function helpSaid(agent: string, hooks: readonly Pick<Hook, "command" | "description" | "hidden">[]): string {
  const shown = hooks.filter((hook) => !hook.hidden && hook.command !== "/help");
  const grouped = new Set(HELP_GROUPS.flatMap(([, commands]) => commands));
  const blocks = [...HELP_GROUPS, ["More", shown.filter((hook) => !grouped.has(hook.command)).map((hook) => hook.command)] as const]
    .map(([title, commands]) => [title, commands.flatMap((command) => shown.find((hook) => hook.command === command) ?? [])] as const)
    .filter(([, mine]) => mine.length > 0)
    .map(([title, mine]) => [`**${title}**`, uses(mine.map((hook) => [hook.command, hook.description]))].join("\n"));
  return [titled(`Commands for ${agent}`), ...blocks].join("\n\n");
}

export const metaHooks: Hook[] = [
    {
      command: "/help",
      description: "List the commands",
      worksWhilePaused: true,
      handler: async (ctx) => ({ handled: true, reply: helpSaid(ctx.agent.config.displayName, ctx.deps.listHooks?.() ?? []) }),
    },

    {
      command: "/commands",
      description: "Put these commands in this chat app's own menu",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const gateway = ctx.deps.resolveGateway?.(ctx.gatewayId);
        if (!gateway) {
          return { handled: true, reply: "Cannot resolve the gateway for this chat." };
        }
        if (!gateway.syncCommands) {
          return { handled: true, reply: "This platform does not support a command menu." };
        }
        const hooks = (ctx.deps.listHooks?.() ?? []).filter((h) => !h.hidden);
        const commands = hooks
          .map((h) => ({
            command: h.command.replace(/^\//, ""),
            description: h.description,
          }));
        try {
          const result = await gateway.syncCommands(commands);
          return {
            handled: true,
            reply: `Put ${result.synced} ${plural(result.synced, "command")} in this chat app's menu.`,
          };
        } catch (err) {
          return { handled: true, reply: failed("Command sync", err, ctx) };
        }
      },
    },
];
