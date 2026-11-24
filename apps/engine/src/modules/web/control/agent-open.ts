/**
 * What an agent's page is told about being open to everyone (`AgentOpen`): whether it may be, where strangers would
 * reach it, the limits its pack holds, and while it is open what was used of them today. One reading for the switch
 * and for the figures beside it, so the page never says a number the door is not counting by.
 */

import { isOpenAgent, type LoadedAgent } from "@nouride/shared";
import type { AgentOpen } from "@nouride/wire";
import { startOfLocalDay } from "@/commons/clock.ts";
import { hasNotes } from "@/modules/setup/open-agent.ts";
import type { ControlDeps } from "./types.ts";

export function openOf(deps: Pick<ControlDeps, "ctx" | "usage" | "openDoor">, agent: LoadedAgent, now: number = Date.now()): AgentOpen {
  const { config } = deps.ctx;
  const id = agent.config.id;
  const limits = agent.config.open;
  const today = (): NonNullable<AgentOpen["today"]> => {
    const day = startOfLocalDay(now, config.daemon.timezone);
    const used = deps.usage?.since(day, id);
    return { tokens: used ? used.inputTokens + used.outputTokens : 0, estimated: (used?.estimatedRequests ?? 0) > 0, ...(deps.openDoor?.today(id, day) ?? { people: 0, messages: 0 }) };
  };
  return {
    never: config.daemon.orchestrator === id ? "orchestrator" : agent.config.external ? "cli" : null,
    notes: hasNotes(agent.persona.memory),
    connections: config.gateways.filter((gateway) => gateway.enabled && gateway.agent === id).map((gateway) => gateway.id),
    limits: limits ? { maxDailyTokens: limits.maxDailyTokens, maxDailyMessagesPerPerson: limits.maxDailyMessagesPerPerson, closedReply: limits.closedReply ?? null } : null,
    ...(isOpenAgent(agent) ? { today: today() } : {}),
  };
}
