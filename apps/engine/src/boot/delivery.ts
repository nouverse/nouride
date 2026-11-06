/**
 * Replies that never reached their platform.
 *
 * A turn writes its reply before sending it — the answer, or the report of a restart or a failure that
 * ended it — so a process that dies in between, or while the reply sits in a gateway's outbound buffer for
 * a connection that is down, leaves a reply recorded and never delivered. The next boot sends it, once,
 * when it is recent: an answer half an hour late still answers the question; one from yesterday would only
 * confuse.
 *
 * A reply that landed in part is marked delivered and not sent again: a repeated head is worse than a lost
 * tail, and the whole text is in the conversation and on the dashboard.
 */

import { createLogger } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import type { DeliveryPort } from "@/modules/turns/delivery.store.ts";

const log = createLogger("daemon");

/** How far back a turn may have started for its undelivered reply to still be sent. */
const UNDELIVERED_WINDOW_MS = 30 * 60_000;

export async function deliverUndelivered(input: {
  delivery: DeliveryPort;
  notifier: Pick<Notifier, "toChat">;
  now?: number;
}): Promise<number> {
  const pending = input.delivery.undelivered((input.now ?? Date.now()) - UNDELIVERED_WINDOW_MS);
  let sent = 0;
  for (const turn of pending) {
    // A job's own session is not an address anybody reads.
    if (turn.chatId.startsWith("cron:")) continue;
    if (await input.notifier.toChat({ gatewayId: turn.gatewayId, chatId: turn.chatId }, turn.reply)) {
      input.delivery.markDelivered(turn.id);
      sent += 1;
    }
  }
  if (sent > 0) log.info("sent replies the last process wrote and never delivered", { replies: sent });
  return sent;
}
