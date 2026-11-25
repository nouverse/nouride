/**
 * Where a question only an admin answers is put in front of each admin (0.8.10, `ApprovalPrompts.adminChats`): their own
 * chat, found the way the morning line finds a person (`morningRoute`) — the account they picked, the one they last wrote
 * from, then the rest — on a connected gateway of its platform. One chat an admin. A dashboard account is not a chat:
 * the Approvals page lists the question there already.
 */

import type { Gateway, GlobalConfig } from "@nouride/shared";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { accountsOf, morningRoute } from "./morning-lines.ts";

export function adminChatsOf(params: {
  config: () => Pick<GlobalConfig, "people">;
  gateways: Map<string, Gateway>;
  turns: Pick<TurnsPort, "lastFrom">;
  /** An admin by People: their dashboard account holds the admin role (`Pipeline.isAdmin`). */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  /**
   * Whether a connection is an agent's open to everyone: never one an admin's question goes out on, whoever wrote there
   * last. Its phone, or its bot's chat, is the public's, and the question names what is asked on the household's side.
   */
  openOn?: (gatewayId: string) => boolean;
}): () => { gatewayId: string; chatId: string }[] {
  return () =>
    params
      .config()
      .people.filter((person) => accountsOf(person).some((one) => one.platform === "web" && params.isAdmin({ gatewayId: LOCAL_GATEWAY_ID, senderId: one.account })))
      .flatMap((person) => {
        const lastFrom = params.turns.lastFrom(accountsOf(person).map((one) => one.account));
        const connected = (gateway: Gateway | undefined, platform: string): gateway is Gateway => gateway?.platform === platform && gateway.status === "connected" && params.openOn?.(gateway.id) !== true;
        for (const { platform, account } of morningRoute(person, lastFrom)) {
          // The connection they last wrote on from that account, where it is up: with two WhatsApp numbers, the first
          // connected one was the shop's as often as the household's, and a question about the household came from it.
          const wroteOn = lastFrom.map((turn) => (turn.senderId === account ? params.gateways.get(turn.gatewayId) : undefined)).find((gateway) => connected(gateway, platform));
          const gateway = wroteOn ?? [...params.gateways.values()].find((one) => connected(one, platform));
          if (gateway) return [{ gatewayId: gateway.id, chatId: account }];
        }
        return [];
      });
}
