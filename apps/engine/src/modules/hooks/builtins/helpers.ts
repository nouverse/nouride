/**
 * `/helpers`: who is working for this agent in the background now. The helpers it started (`delegate`) and the agents
 * it asked (`ask_agent`) whose answers have not come back: for the person both are somebody at work for the agent.
 *
 * A person had `/stop` to end them and nothing to see them with: a helper that ran forty minutes was known only by the
 * agent's own word, or by the dashboard. Only what is running; what ended reported to the chat when it did.
 *
 * A room sees what was started from that room. A direct chat sees what was started from it, and what the person
 * started elsewhere; an admin there sees all of the agent's. A brief can hold what another chat said, so it is not
 * shown to whoever happens to write to the agent.
 */

import { clip } from "@nouride/shared";
import { formatDuration } from "../format.ts";
import type { Hook, HookContext } from "../types.ts";

/** One piece of work in the background, as `/helpers` lists it. Built by the pipeline from the jobs. */
export interface WorkingInBackground {
  id: string;
  /** The agent asked, for an ask; null for a helper. */
  asked: string | null;
  /** What it was given to do: a helper's goal, an ask's task. */
  what: string;
  gatewayId: string;
  chatId: string;
  /** The person whose turn started it. */
  senderId: string | null;
  startedAt: number;
  /** When its log was last written, a line at each step it makes; null before the first. */
  lastWroteAt: number | null;
}

const GOAL_SHOWN = 160;

function seen(ctx: HookContext, one: WorkingInBackground): boolean {
  if (one.gatewayId === ctx.gatewayId && one.chatId === ctx.chatId) return true;
  if (ctx.envelope.chatType !== "dm") return false;
  return ctx.deps.isAdmin?.(ctx.envelope) === true || (one.gatewayId === ctx.gatewayId && one.senderId === ctx.senderId);
}

/** The list, as the chat reads it (pure). */
export function helpersSaid(input: { agent: string; working: readonly WorkingInBackground[]; here: (one: WorkingInBackground) => boolean; nameOf: (agentId: string) => string; now: number }): string {
  const { agent, working, now } = input;
  if (working.length === 0) return `Nobody is working for ${agent} in the background now.`;
  const ago = (at: number) => formatDuration(Math.max(0, Math.round((now - at) / 1000)));
  const lines = [...working]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((one, index) => {
      const who = one.asked ? `${input.nameOf(one.asked)}, asked` : "A helper";
      const last = one.lastWroteAt === null ? "no step yet" : `last step ${ago(one.lastWroteAt)} ago`;
      const where = input.here(one) ? "" : ", started in another chat";
      return `${index + 1}. ${who}, ${ago(one.startedAt)} so far, ${last}${where}: ${clip(one.what.replace(/\s+/g, " ").trim(), GOAL_SHOWN)} (${one.id})`;
    });
  const fromHere = working.some(input.here);
  return [`${working.length} at work for ${agent} in the background:`, ...lines, ...(fromHere ? ["/stop ends what was started from this chat."] : [])].join("\n");
}

export const helperHooks: Hook[] = [
  {
    command: "/helpers",
    description: "Who is working for this agent in the background now: its helpers and the agents it asked",
    worksWhilePaused: true,
    handler: async (ctx) => {
      const agentId = ctx.agent.config.id;
      const all = ctx.deps.workingInBackground?.(agentId);
      if (!all) return { handled: true, reply: "Background work is not run in this process." };
      const here = (one: WorkingInBackground) => one.gatewayId === ctx.gatewayId && one.chatId === ctx.chatId;
      return {
        handled: true,
        reply: helpersSaid({
          agent: ctx.agent.config.displayName || agentId,
          working: all.filter((one) => seen(ctx, one)),
          here,
          nameOf: (id) => ctx.deps.registry.get(id)?.config.displayName || id,
          now: Date.now(),
        }),
      };
    },
  },
];
