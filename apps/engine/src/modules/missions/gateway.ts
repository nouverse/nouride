/**
 * The connection a mission's conversation runs on: `web:mission`, the chat id being the mission's id.
 *
 * A real `Gateway`, like the dashboard's, so a mission's turn travels the path every chat's does — the queue, routing,
 * approvals, the journal, the jobs that wake it — and nothing new runs beside the pipeline. It is nobody's chat: what
 * the agent says here is its work log, kept in the turn records and shown on the mission's page; what a person hears is
 * the mission's notices, sent to the chat it began in (`notices.ts`).
 */

import type { Gateway, GatewayEvent, GatewayName, GatewayStatus, OutboundMessage } from "@nouride/shared";

export const MISSION_GATEWAY_ID = "web:mission";

/** Whether this conversation is a mission's — the one test every caller makes. */
export function isMissionChat(at: { gatewayId: string }): boolean {
  return at.gatewayId === MISSION_GATEWAY_ID;
}

export class MissionGateway implements Gateway {
  readonly id = MISSION_GATEWAY_ID;
  readonly platform: GatewayName = "web";
  readonly status: GatewayStatus = "connected";
  /** Nothing here has a message id: what is said is read from the turn record. */
  readonly addressableMessages = false;
  /** Nothing sent here comes back as a message. */
  readonly echoesOwnMessages = false;
  /** Nobody connects it: it is not listed with the connections people check. */
  readonly internal = true;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setTyping(): Promise<void> {}
  onMessage(): void {}
  onEvent(_handler: (event: GatewayEvent) => void): void {}

  /** What the agent says here is in its turn's record — the mission's page shows it; nobody else reads it. */
  async send(_message: OutboundMessage): Promise<string[]> {
    return [];
  }
}
