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
import type { LiveEdits } from "@/modules/live-edit/index.ts";
import { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import { scriptFactsOf, type ScriptFacts } from "@/modules/cron/scripts.ts";
import type { CronExecutors } from "@/modules/cron/scheduler.ts";
import { senderIsOwner } from "@/modules/people/match.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { describeAddress, type SendMessageOptions } from "@/modules/tools/builtins/send-message.ts";
import { readBrief } from "./missions.ts";
import type { LinkFor } from "@/modules/web/links.ts";

/**
 * What a script is asked of this machine (`cron/scripts.ts`), for the agents as they are loaded now: the secrets an
 * agent's pack names for its commands, and a program looked for where a job's command of that agent would run.
 */
export function scriptFacts(registry: Pick<AgentRegistry, "get">, pipeline: () => { cronExecutors(): Pick<CronExecutors, "commandSandbox"> }): ScriptFacts {
  return scriptFactsOf({
    secrets: (agentId) => registry.get(agentId)?.config.execSecrets.map((secret) => secret.name) ?? null,
    sandbox: (job) => pipeline().cronExecutors().commandSandbox(job),
  });
}

export function buildProposals(params: {
  cron: CronPort;
  notifier: Pick<Notifier, "ask" | "settle">;
  registry: Pick<AgentRegistry, "get">;
  timezone: () => string;
  /** People, as it is now: whose an automation is, when a change to it is answered from a chat. */
  people: () => readonly Person[];
  /** The job's card on the Schedule page, in the tool's answer (`web/links.ts`, 0.8.11). */
  linkFor?: LinkFor;
  /** Whether a script an agent proposes could run here (`cron/scripts.ts`). */
  scripts?: ScriptFacts;
  /** Where a change to the automation a person has open on its page is held for that page (`modules/live-edit`). */
  liveEdits?: Pick<LiveEdits, "propose">;
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
    ...(params.scripts ? { scripts: params.scripts } : {}),
    ...(params.liveEdits ? { proposeLiveEdit: (offer) => params.liveEdits!.propose(offer) } : {}),
    readBrief,
  });
  return { cards, tool };
}
