/**
 * `/schedule on <id>` and `/schedule discard <id>` — a proposed job answered in words (0.8.0), where a chat has no
 * buttons to press (WhatsApp), or a person would rather type. The same answer a press on its card gives, by the same
 * rule for who may (`cron/proposal-cards.ts`).
 */

import type { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import type { Hook } from "../types.ts";

/** What `/schedule` reaches of the proposals. */
export type ScheduleCommands = Pick<ProposalCards, "answer">;

const USAGE = "/schedule on <id> turns on a job proposed here; /schedule discard <id> lets it go.";

export const scheduleHooks: Hook[] = [
  {
    command: "/schedule",
    description: "Turn on, or discard, a scheduled job an agent proposed here: /schedule on <id>",
    handler: async (ctx) => {
      const cards = ctx.deps.proposals;
      if (!cards) return { handled: true, reply: "Scheduled jobs are not run in this process." };
      const [verb, id] = ctx.args;
      const on = verb === "on" ? true : verb === "discard" ? false : null;
      if (on === null || !id) return { handled: true, reply: USAGE };
      const answered = cards.answer(id, on, {
        gatewayId: ctx.gatewayId,
        chatId: ctx.chatId,
        chatType: ctx.envelope.chatType,
        senderId: ctx.senderId,
        name: ctx.envelope.senderName || ctx.senderId,
        // One of our agents' bots, by the platform's word: a stranger's is dropped before any command runs.
        ...(ctx.envelope.senderIsBot ? { bot: true } : {}),
      });
      return { handled: true, reply: "refused" in answered ? answered.refused : answered.settled.replace(/\*\*/g, "") };
    },
  },
];
