/**
 * What a gateway says about itself, acted on: the command menu published when it connects, and the operator alerted
 * when it dies, when its session expires, or when the platform refuses a reply it took. `Pipeline.attach` hands every
 * gateway's events here; it was the second half of `attach()`.
 */

import { createLogger, type Gateway, type GatewayEvent } from "@nouride/shared";
import type { PipelineDeps } from "./deps.ts";

const log = createLogger("pipeline");

/** One event from `gateway`. `menu` is the list the dashboard's `/` menu reads — one source for both menus. */
export function onGatewayEvent(
  gateway: Gateway,
  event: GatewayEvent,
  menu: () => { command: string; description: string }[],
  notifier: PipelineDeps["notifier"],
): void {
  /**
   * Publish the command menu when a connection comes up.
   *
   * It used to be `/commands`, typed by hand, and nothing else. So the day `/auto` became
   * `/approvals` the Telegram menu went on offering `/auto` — a rename that shipped, deployed,
   * and then lied in the one place a person actually looks for the list. Nobody forgets to type a
   * maintenance command because they are careless; they forget because the command exists.
   *
   * On connect rather than at boot: a gateway that reconnects after an outage gets the current
   * list too, and `setMyCommands` is a full replace, so doing it again is free and idempotent.
   * Fire-and-forget — a stale menu must never keep a working gateway from delivering messages.
   */
  if (event.type === "status" && event.status === "connected" && gateway.syncCommands) {
    // The same list the dashboard's `/` menu reads, minus the leading slash a platform menu
    // adds back itself. One source, so the two menus cannot drift apart.
    const commands = menu().map(({ command, description }) => ({
      command: command.replace(/^\//, ""),
      description,
    }));
    void gateway
      .syncCommands(commands)
      .then(({ synced }) =>
        log.info("command menu published", { gateway: event.gatewayId, synced }),
      )
      .catch((err: unknown) =>
        log.warn("could not publish the command menu", {
          gateway: event.gatewayId,
          error: String(err),
        }),
      );
  }

  if (event.type === "dead") {
    log.error("gateway is dead: messages will not be delivered", {
      gateway: event.gatewayId,
    });
    // Reaching the operator matters more here than anywhere else: a dead gateway is
    // *silent*, and silence is indistinguishable from "nobody messaged me". Sent through
    // whatever channel is still alive, which is why alerts are not routed per-gateway.
    void notifier?.alert(
      `gateway_dead:${event.gatewayId}`,
      event.reason === "auth_failed"
        ? `${event.gatewayId} refused its credentials, so it stopped trying: ${event.detail ?? "the token was rejected"}. ` +
            `Messages there are not being delivered until it has one that works. Store it, then \`nouride gateway restart ${event.gatewayId}\``
        : `${event.gatewayId} is disconnected and gave up reconnecting after ${event.attempts} attempts. ` +
            `Messages there are not being delivered. \`nouride gateway restart ${event.gatewayId}\``,
    );
  }
  if (event.type === "session_expired") {
    void notifier?.alert(
      `session_expired:${event.gatewayId}`,
      `${event.gatewayId} needs to be linked again: its session expired.`,
    );
  }
  /**
   * The platform took a reply and then refused to deliver it.
   *
   * Alerted for the same reason a dead gateway is: from the outside it is indistinguishable
   * from the agent ignoring somebody. Worse, actually — a dead gateway at least shows as
   * disconnected, while this one reports itself healthy, the send resolves, and the person
   * watches an empty chat. It cost a day before anyone could see it.
   *
   * The alert goes to a channel that is by definition not the one that failed.
   */
  if (event.type === "delivery_refused") {
    log.error("a reply was refused by the platform", {
      gateway: event.gatewayId,
      chat_id: event.chatId,
      code: event.code,
    });
    void notifier?.alert(
      `delivery_refused:${event.gatewayId}:${event.chatId}`,
      `${event.gatewayId} could not deliver a reply to ${event.chatId}. ${event.reason}`,
    );
  }
}
