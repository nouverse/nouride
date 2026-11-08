/**
 * Slash commands — handled instead of an agent turn.
 *
 * A command answers immediately and costs no model call, which is why the queue treats them as
 * urgent (see `pipeline/chat-queue.ts`): the turn that is waiting on an approval holds the conversation's
 * key, so an `/approve` queued behind it could never unblock it.
 *
 * The registry is here; the commands themselves are in `builtins/`, grouped by what they act on —
 * the conversation, the approval gate, the agent, or the command list itself.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import type { Hook,HookDeps, HookResult } from "./types.ts";
import { parseCommand } from "./parse.ts";
import { sessionHooks } from "./builtins/session.ts";
import { notesHooks } from "./builtins/notes.ts";
import { approvalHooks } from "./builtins/approvals.ts";
import { agentHooks } from "./builtins/agent.ts";
import { metaHooks } from "./builtins/meta.ts";
import { draftHooks } from "./builtins/drafts.ts";
import { daemonHooks } from "./builtins/daemon.ts";
import { secretHooks } from "./builtins/secrets.ts";
import { mentionHooks } from "./builtins/mention.ts";
import { missionHooks } from "./builtins/mission.ts";
import { scheduleHooks } from "./builtins/schedule.ts";
import { sideHooks } from "./builtins/side.ts";

export type { Hook, HookContext, HookDeps, HookResult } from "./types.ts";
export { ModelOverrides } from "./model-overrides.ts";
export { parseCommand } from "./parse.ts";
export { drainCoveredPending, noPendingReply } from "./pending.ts";

const log = createLogger("hooks");

export class HookRegistry {
  private hooks = new Map<string, Hook>();

  constructor(private readonly deps: HookDeps) {
    for (const hook of builtinHooks()) this.hooks.set(hook.command, hook);
  }

  list(): Hook[] {
    return [...this.hooks.values()].sort((a, b) => a.command.localeCompare(b.command));
  }

  has(command: string): boolean {
    return this.hooks.has(command);
  }

  /** A command about the group rather than an agent (`Hook.aboutTheGroup`). */
  aboutTheGroup(command: string): boolean {
    return this.hooks.get(command)?.aboutTheGroup === true;
  }

  /** A command a paused agent still answers — `/start` above all. Words, and every other command, wait for `/start`. */
  answersWhilePaused(text: string): boolean {
    const command = parseCommand(text);
    return command !== null && this.hooks.get(command.command)?.worksWhilePaused === true;
  }

  async run(
    command: string,
    args: string[],
    agent: LoadedAgent,
    envelope: MessageEnvelope,
  ): Promise<HookResult> {
    const hook = this.hooks.get(command);
    if (!hook) {
      return {
        handled: true,
        reply: `Unknown command \`${command}\`. Try /help.`,
      };
    }

    if (this.deps.registry.isPaused(agent.config.id) && !hook.worksWhilePaused) {
      return { handled: true, reply: "I'm asleep. /wake wakes me." };
    }

    log.info("hook", { agent_id: agent.config.id, command, args_count: args.length });

    return await hook.handler({
      agent,
      envelope,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      senderId: envelope.senderId,
      args,
      deps: this.deps,
    });
  }
}

/**
 * Every built-in command, in menu order.
 *
 * Order is display only — `has()` and `run()` look up by name — but it is what `list()` returns, so
 * it decides the order in the harness prompt and in a platform's slash-command menu. It now follows
 * the grouping rather than the order these were written in, which moves the approval commands to the
 * end; `/help` writes its own list and is unaffected.
 */
function builtinHooks(): Hook[] {
  return [...metaHooks, ...sessionHooks, ...sideHooks, ...notesHooks, ...missionHooks, ...scheduleHooks, ...agentHooks, ...draftHooks, ...approvalHooks, ...secretHooks, ...mentionHooks, ...daemonHooks];
}
