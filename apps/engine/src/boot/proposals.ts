/**
 * Scheduled work an agent proposes (0.8.0): the cards a proposal is answered on, and the `schedule` tool that makes
 * one — built together, since the tool posts what the cards answer. The pipeline is read when a card is posted or
 * pressed, which is after it exists.
 */

import type { Person, Tool } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { Notifier } from "@/commons/notify.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import { describeTrigger } from "@/modules/cron/parse.ts";
import { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import { senderIsOwner } from "@/modules/people/match.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { describeAddress, type SendMessageOptions } from "@/modules/tools/builtins/send-message.ts";
import { readBrief } from "./missions.ts";
import type { LinkFor } from "@/modules/web/links.ts";

export function buildProposals(params: {
  cron: CronPort;
  notifier: Pick<Notifier, "ask" | "settle">;
  registry: Pick<AgentRegistry, "get">;
  timezone: () => string;
  /** People, as it is now: whose an automation is, when a change to it is answered from a chat. */
  people: () => readonly Person[];
  /** The job's card on the Schedule page, in the tool's answer (`web/links.ts`, 0.8.11). */
  linkFor?: LinkFor;
  /** The pipeline's voice, admins and the chats an agent can reach — read when a card is posted or answered. */
  pipeline: () => { voiceGatewayId(agentId: string, gatewayId: string): string; isAdmin(who: { gatewayId: string; senderId: string }): boolean; messageSender(): Pick<SendMessageOptions, "targets"> };
}): { cards: ProposalCards; tool: Tool } {
  const chats = (agentId: string) => params.pipeline().messageSender().targets({ agentId });
  const cards = new ProposalCards({
    store: params.cron,
    notifier: params.notifier,
    voice: (agentId, gatewayId) => params.pipeline().voiceGatewayId(agentId, gatewayId),
    isAdmin: (who) => params.pipeline().isAdmin(who),
    isOwner: (who, owner) => senderIsOwner(params.people(), who, owner),
    when: (job) => describeTrigger(job.trigger, params.timezone()),
    results: (job) => (job.delivery.gatewayId && job.delivery.chatId ? describeAddress(chats(job.agentId), { gatewayId: job.delivery.gatewayId, chatId: job.delivery.chatId }) : null),
  });
  const tool = createScheduleTool({
    store: params.cron,
    timezone: params.timezone,
    agentExists: (agentId) => params.registry.get(agentId) !== undefined,
    post: (job) => cards.post(job),
    chats,
    ...(params.linkFor ? { linkFor: params.linkFor } : {}),
    readBrief,
  });
  return { cards, tool };
}
