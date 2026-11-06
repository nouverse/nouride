/**
 * A bot's own presence follows its agent (0.8.0): online while it works or waits for a person, idle when it has nothing
 * to do, do-not-disturb while it is asleep — so a person sees at a glance, in the member list, which agent is off duty.
 *
 * Only where a connection can show one (`Gateway.setPresence` — Discord's), and only for a connection that is one
 * agent's own: a bot several agents share has no single status to show. Worked out from what the daemon holds in memory
 * (`agent-status.ts`) every half minute, and sent only when it changes.
 */

import { contained, createLogger, type Gateway, type GatewayPresence, type GlobalConfig } from "@nouride/shared";
import { presenceFor, type AgentStatus } from "@/modules/pipeline/agent-status.ts";

const log = createLogger("boot.presence");

const EVERY_MS = 30_000;

export function startPresence(params: {
  gateways: ReadonlyMap<string, Gateway>;
  config: () => GlobalConfig;
  status: (agentId: string) => AgentStatus;
}): ReturnType<typeof setInterval> {
  const shown = new Map<string, GatewayPresence>();
  const update = contained(log, "a bot's presence could not be updated", () => {
    for (const instance of params.config().gateways) {
      const gateway = params.gateways.get(instance.id);
      if (!instance.enabled || !instance.agent || !gateway?.setPresence) continue;
      const presence = presenceFor(params.status(instance.agent).activity);
      if (shown.get(instance.id) === presence) continue;
      shown.set(instance.id, presence);
      gateway.setPresence(presence);
    }
  });
  update();
  return setInterval(update, EVERY_MS);
}
