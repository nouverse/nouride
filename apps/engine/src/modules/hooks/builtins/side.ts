/**
 * `/btw <question>` (0.8.17): a side question, answered beside the work by a turn of its own that only reads, and kept
 * out of the conversation (`pipeline/side-question.ts`). A hook, so it runs before the busy guard: answered while a
 * turn runs, and when none does.
 */

import type { Hook } from "../types.ts";

export const sideHooks: Hook[] = [
  {
    command: "/btw",
    description: "Ask something beside the work: answered read-only, kept out of the conversation",
    handler: async (ctx) => {
      if (!ctx.deps.sideQuestion) return { handled: true, reply: "Side questions are not wired up in this build." };
      return { handled: true, reply: await ctx.deps.sideQuestion(ctx.agent, ctx.envelope, ctx.args.join(" ")) };
    },
  },
];
