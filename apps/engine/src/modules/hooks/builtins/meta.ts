/**
 * The two commands about the commands: the help list, and pushing that list into a platform's own
 * slash-command menu.
 */

import { failed } from "../format.ts";
import type { Hook } from "../types.ts";

export const metaHooks: Hook[] = [
    {
      command: "/help",
      description: "List available commands",
      worksWhilePaused: true,
      handler: async (ctx) => ({
        handled: true,
        reply: [
          `Commands for **${ctx.agent.config.displayName}**:`,
          "`/new` start a new conversation (keeps memory)",
          "`/reset` clear conversation and reload config from disk",
          "`/status` model, uptime, context size",
          "`/stop` pause me · `/start` resume me",
          "`/model <name>` switch model for this chat · `/model` show current",
          "`/agents` list agents and their state",
          "`/approve` answer the request waiting now · add `always` to stop being asked for it",
          "`/approve all` answer every one waiting · `/deny [id]` refuse one",
          "`/approvals` how much I ask before running tools · `/approvals balanced` only the dangerous ones",
          "`/grants` standing command permissions · `/grants revoke <id|all>`",
          "`/mention` whether this group needs a mention · `/mention off|on|default` change it (admins)",
          "`/compact` summarize the conversation so far, keeping the recent turns",
          "`/btw <question>` ask something beside the work: answered read-only, kept out of the conversation",
          "`/reload` re-read my persona files and config",
          "`/prompt` show the exact system prompt I'm running with (DM only)",
          "`/daemon-restart` restart the daemon once nothing is running · `/daemon-restart now` to not wait",
          "`/commands` sync slash commands to this platform's menu",
          "`/help` this list",
        ].join("\n"),
      }),
    },

    {
      command: "/commands",
      description: "Sync slash commands to this platform's menu",
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
            reply: `Synced ${result.synced} command(s) to ${gateway.platform}.`,
          };
        } catch (err) {
          return { handled: true, reply: failed("Command sync", err, ctx) };
        }
      },
    },
];
