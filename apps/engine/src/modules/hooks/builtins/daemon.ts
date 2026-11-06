/**
 * `/daemon-restart` — the daemon itself, from a chat.
 *
 * Asked for so a change to an agent's config can be applied from a phone; the dashboard and `nouride
 * restart` could already do it. Named for what it restarts: `/restart` reads as the conversation, which is
 * `/new`, or the agent, which is `/reload` — and this ends every conversation on the daemon for a moment.
 *
 * The same path as the other two — `modules/update/restart.ts` — so it waits for running work the same
 * way, and the chat it was typed in is told when the daemon is back. That line comes from the daemon, not
 * the model: a restart is often *because* of the model, and the notice must not depend on it.
 */

import type { Hook } from "../types.ts";

/** What the chat that asked reads once the daemon is back. */
const RESTARTED_NOTICE = "✓ Restarted, I'm back.";

const daemonRestart: Hook = {
  command: "/daemon-restart",
  description: "Restart the daemon once nothing is running (`/daemon-restart now` to not wait)",
  // It is the daemon that restarts, not this agent, so pausing the agent has nothing to say about it.
  worksWhilePaused: true,
  handler: async (ctx) => {
    const restart = ctx.deps.restart;
    if (!restart) return { handled: true, reply: "Restarting is not available on this daemon." };
    // The dashboard's chat answers to the dashboard's roles, which a hook cannot see — and the page has a button.
    if (ctx.envelope.gateway === "web") {
      return { handled: true, reply: "Use **Restart** on the dashboard's Overview page: it shows when the daemon is back." };
    }
    /**
     * Only an admin, the same as on the dashboard. Everyone who reaches a hook got through admission, and on
     * an `open` connection that proves nothing — a restart typed by anyone else ends every conversation on the
     * daemon, not just theirs. So: paired or on an allowlist, and, under People, the same person as an admin's
     * dashboard account — two decisions an admin made about this person, neither of them the sender's.
     */
    if (!restart.mayRestart(ctx.envelope)) {
      return {
        handled: true,
        reply:
          "Only an admin can restart me from a chat: someone paired with me whose person, under People, is linked to an " +
          "admin's dashboard account. The dashboard can, and so can `nouride restart`.",
      };
    }
    // Sent before this process started: the restart it asked for is the one that started it — a message put
    // back from the inbox, or a platform delivering it again. Restarting for it would never end.
    if (ctx.envelope.timestamp > 0 && ctx.envelope.timestamp < ctx.deps.daemon.startedAt) {
      return { handled: true, reply: "I've restarted since you sent that, so I'm not restarting again." };
    }

    const now = ctx.args.some((arg) => arg.toLowerCase() === "now");
    const outcome = restart.request({
      by: `${ctx.gatewayId}:${ctx.senderId}`,
      now,
      followUp: { kind: "notice", agentId: ctx.agent.config.id, gatewayId: ctx.gatewayId, chatId: ctx.chatId, text: RESTARTED_NOTICE },
    });
    if (!outcome) return { handled: true, reply: "Restarting is not available on this daemon." };
    if (!outcome.ok) return { handled: true, reply: `Not restarting: ${outcome.error}.${outcome.note ? `\n${outcome.note}` : ""}` };
    return {
      handled: true,
      reply: now
        ? "Restarting now. I'll say here when I'm back."
        : outcome.waitingFor
          ? `Restarting once ${outcome.waitingFor} is done, however long that takes. I'll say here when I'm back.\n\`/daemon-restart now\` to stop it and restart now.`
          : "Restarting once nothing else is running, within ten minutes. I'll say here when I'm back.\n`/daemon-restart now` to not wait.",
    };
  },
};

/**
 * Telegram's command menu takes `[a-z0-9_]` only, so it lists this as `/daemon_restart` (`syncCommands` in
 * its gateway) — and a tap sends that spelling. Answered, and kept out of the menus that can show the hyphen.
 */
export const daemonHooks: Hook[] = [daemonRestart, { ...daemonRestart, command: "/daemon_restart", hidden: true }];
