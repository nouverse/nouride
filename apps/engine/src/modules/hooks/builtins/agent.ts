/**
 * Commands about the agent rather than the conversation: which model it runs, who else is here,
 * what prompt it is actually carrying, and re-reading its pack from disk.
 */

import { isLlmEffort, LLM_EFFORTS } from "@nouride/shared";
import type { Hook, HookContext } from "../types.ts";
import { failed, sessionKey } from "../format.ts";

export const agentHooks: Hook[] = [
    {
      command: "/model",
      description: "Switch model for this chat",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const key = sessionKey(ctx);
        const session = ctx.deps.sessions.load(key);
        const requested = ctx.args[0];

        if (!requested) {
          const current = ctx.deps.modelOverrides.get(session.id) ?? ctx.agent.config.llm.model;
          return { handled: true, reply: `Current model: \`${current}\`` };
        }

        if (requested === "reset" || requested === "default") {
          ctx.deps.modelOverrides.clear(session.id);
          return { handled: true, reply: `Back to \`${ctx.agent.config.llm.model}\`.` };
        }

        // Not validated against a model list: the whole point of TD-004 is that base_url can
        // point anywhere, so the set of valid names is not something the daemon can know. A
        // wrong name surfaces as a provider error on the next turn.
        ctx.deps.modelOverrides.set(key, requested);
        return { handled: true, reply: `Model for this chat is now \`${requested}\`.` };
      },
    },

    {
      command: "/effort",
      description: "How long the model thinks, for this chat; with lock, for every chat and mission",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const own = ctx.agent.config.llm?.effort;
        const key = sessionKey(ctx);
        const session = ctx.deps.sessions.load(key);
        const requested = ctx.args[0]?.toLowerCase();
        const then = ctx.args[1]?.toLowerCase();
        const chosen = ctx.deps.modelOverrides.effortOf(session.id);
        /**
         * Claude Code and Codex (0.8.16): their CLI says which levels it offers for the model it is on, and a level is set
         * on the running session, so a level the CLI would not take is refused here. An agent its own model answers (0.8.17)
         * sends the level with each request; a model that refuses it is asked again without, and the chat is told with the
         * answer (`EffortGuard`, `effortRefusedNote`). One that takes it and ignores it cannot be told apart, so what is
         * said here is what is sent, never how the model thinks.
         */
        const cli = ctx.agent.config.external !== undefined;
        const offered = cli ? (ctx.deps.cliEfforts?.(ctx.agent.config.id) ?? []) : [];
        const offers = !cli ? "" : offered.length > 0 ? ` It offers: ${offered.join(", ")}.` : " Its CLI says which levels it offers once a session has opened.";
        const fallsTo = cli ? "the CLI's own" : "its provider's default";

        if (!requested) {
          const now = chosen ? `\`${chosen}\`, set in this chat` : own ? `\`${own}\`, the agent's` : fallsTo;
          const refusal = ctx.deps.modelOverrides.refusalOf(session.id);
          const refused = chosen && refusal?.effort === chosen ? ` \`${refusal.model}\` refused it, so it is sent none.` : "";
          return { handled: true, reply: `Effort for this chat: ${now}.${refused}${offers}` };
        }
        // `/effort <level> lock`, `/effort lock` (this chat's level), `/effort unlock`: the agent's own, not this chat's.
        if (requested === "lock" || requested === "unlock" || then !== undefined) {
          const alone = requested === "lock" || requested === "unlock";
          if ((alone && then !== undefined) || (!alone && then !== "lock") || ctx.args.length > 2) return { handled: true, reply: LOCK_USAGE };
          const level = requested === "lock" ? chosen : requested === "unlock" || requested === "default" || requested === "reset" ? "default" : requested;
          return { handled: true, reply: await lock(ctx, session.id, level, offered, offers, fallsTo) };
        }
        if (requested === "default" || requested === "reset") {
          ctx.deps.modelOverrides.clearEffort(session.id);
          return { handled: true, reply: own ? `Back to the agent's effort, \`${own}\`.` : cli ? "Back to the CLI's own effort." : "Back to its provider's default." };
        }
        if (!isLlmEffort(requested)) {
          return { handled: true, reply: `\`${requested}\` is not a level: ${LLM_EFFORTS.join(", ")}, or default.` };
        }
        if (offered.length > 0 && !offered.includes(requested)) {
          return { handled: true, reply: `Its CLI does not offer \`${requested}\` for the model it is on.${offers}` };
        }
        ctx.deps.modelOverrides.setEffort(key, requested);
        return { handled: true, reply: `Effort for this chat is now \`${requested}\`, from the next message.` };
      },
    },

    {
      command: "/agents",
      description: "List agents",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const lines = ctx.deps.registry.all().map((agent) => {
          const status = ctx.deps.registry.status(agent.config.id);
          const enabled = agent.config.enabled ? status : "disabled";
          return `- \`${agent.config.id}\` ${agent.config.emoji ?? ""} ${agent.config.displayName}: ${enabled}`.replace(
            /\s+/g,
            " ",
          );
        });

        const failures = ctx.deps.registry.loadFailures();
        if (failures.length > 0) {
          lines.push(...failures.map((f) => `- \`${f.id}\` failed to load: ${f.error}`));
        }

        return { handled: true, reply: lines.join("\n") || "No agents loaded." };
      },
    },

    {
      command: "/prompt",
      description: "Show the system prompt this agent is running with",
      worksWhilePaused: true,
      handler: async (ctx) => {
        // DM only. The prompt contains SOUL and MEMORY — everything the agent knows about the
        // person it works for — and dumping that into a group chat would leak it to everyone
        // present. This is an operator debugging tool, and an operator can open a DM.
        if (ctx.envelope.chatType !== "dm") {
          return { handled: true, reply: "Ask me that in a direct message. It includes my memory." };
        }
        if (!ctx.deps.renderPrompt) {
          return { handled: true, reply: "Prompt inspection is not wired up in this build." };
        }

        /**
         * Sent whole. The adapter decides how it gets onto the wire.
         *
         * It used to be cut at 3500 characters, which on any real persona pack threw away everything
         * the diagnostic exists to show: SOUL alone runs past that, so the harness block — the tools,
         * the workspace, the OTHER AGENTS section — was never once printed. Found on a live box while
         * checking exactly that section, and it looked like the section was missing rather than the
         * output.
         *
         * A message-length limit does not belong here anyway (§2 of the contributing invariants):
         * Telegram chunks at 4096, Discord at 2000, the CLI has no limit at all, and each adapter
         * already knows its own number. One guess in shared code cannot be right for all three.
         */
        return { handled: true, reply: await ctx.deps.renderPrompt(ctx.agent.config.id, ctx) };
      },
    },

    {
      command: "/reload",
      description: "Reload persona files and config from disk",
      worksWhilePaused: true,
      handler: async (ctx) => {
        try {
          const agent = await ctx.deps.registry.reload(ctx.agent.config.id);
          return {
            handled: true,
            reply: `Reloaded. Model \`${agent.config.llm.model}\`, ${agent.skills.length} skill(s), ${agent.config.tools.enabled.length} tool(s).`,
          };
        } catch (err) {
          return { handled: true, reply: failed("Reload", err, ctx) };
        }
      },
    },
];

const LOCK_USAGE =
  "`/effort <level>` sets this chat's · `/effort <level> lock` the agent's own, for every chat and mission (admins) · " +
  "`/effort lock` locks this chat's level · `/effort unlock` takes the agent's own away";
const NOT_ADMIN = "Only an admin can lock an effort: it is written in the agent's config, for every chat. `/effort <level>` sets this chat's.";

/**
 * `/effort <level> lock` (0.8.17): the level made the agent's own, `[llm] effort` in its pack, for every chat and every
 * mission. `/effort <level>` is one conversation's, and a mission runs in a conversation of its own, so it read the
 * pack's level whatever its chat had set. The pack is every chat's: the write is an admin's, as `/mention` and
 * `/secret` are, and it is the one the Model tab makes. "default" takes it away.
 */
async function lock(ctx: HookContext, sessionId: string, level: string | undefined, offered: readonly string[], offers: string, fallsTo: string): Promise<string> {
  const port = ctx.deps.agentEffort;
  if (!port) return "An agent's own effort is not set from a chat on this daemon: its Model tab sets it.";
  if (level === undefined) return "This chat has no level of its own to lock: `/effort <level> lock` sets the agent's.";
  if (level !== "default" && !isLlmEffort(level)) return `\`${level}\` is not a level: ${LLM_EFFORTS.join(", ")}.`;
  if (level !== "default" && offered.length > 0 && !offered.includes(level)) return `Its CLI does not offer \`${level}\` for the model it is on.${offers}`;
  if (!port.mayChange(ctx.envelope)) return NOT_ADMIN;
  const saved = await port.set(ctx.agent.config.id, level, `${ctx.gatewayId}:${ctx.senderId}`);
  if (!saved.ok) return `Not locked: ${saved.error}`;
  // This chat follows the agent's own from here, rather than a level of its own that would hide the new one.
  ctx.deps.modelOverrides.clearEffort(sessionId);
  const name = ctx.agent.config.displayName;
  return level === "default"
    ? `${name} has no effort of its own now: every chat and mission follows the install's \`[llm.defaults] effort\`, else ${fallsTo}.`
    : `\`${level}\` is now ${name}'s own effort, for every chat and mission, and kept across a restart. \`/effort <level>\` still sets one chat's.`;
}
