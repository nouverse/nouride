/**
 * Whether a turn's reply reached its platform.
 *
 * A turn writes its reply before sending it (`turn_records.reply`), so a process that dies in between — or
 * while the reply waits in a gateway's outbound buffer for a connection that is down — leaves a reply that
 * was never delivered. `delivered_at` is what tells the two apart, and `boot/delivery.ts` sends what is
 * left. Beside the turn store rather than in it: it is one question about a turn, asked from two places.
 *
 * `delivered_at` reads three ways. `0`: the reply is committed and on its way, set in the same transaction
 * that commits it (`awaiting`). A time: it landed then. `NULL`: nothing is owed — a command's answer or a
 * refusal, recorded after it was sent, or a turn that sent nothing. Only `0` is sent again, so a reply path
 * that never marks itself is never repeated: a reply sent twice is worse than one lost, and that is the
 * failure this default rules out. Found on a live box the other way round, when a `/reset` answered eight
 * minutes before a restart was sent again after it.
 */

import type { Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

export class DeliveryStore {
  constructor(private readonly db: SqliteDb) {}

  /** This turn's reply is committed and about to be sent. In the transaction that commits it. */
  awaiting(turnId: string): void {
    this.db.prepare("UPDATE turn_records SET delivered_at = 0 WHERE id = ? AND delivered_at IS NULL").run(turnId);
  }

  /** The platform took this turn's reply — `voice.reply`, or a buffered copy flushed later. */
  markDelivered(turnId: string, at: number = Date.now()): void {
    this.db.prepare("UPDATE turn_records SET delivered_at = ? WHERE id = ? AND COALESCE(delivered_at, 0) = 0").run(at, turnId);
  }

  /**
   * Replies of turns started since `since` that were on their way and never landed — an answer, or what a
   * turn cut short told its person. The dashboard's own connection is left out: a reply there is read from
   * the record.
   */
  undelivered(since: number): { id: string; gatewayId: string; chatId: string; reply: string }[] {
    return this.db
      .prepare<{ id: string; gateway_id: string; chat_id: string; reply: string }>(
        `SELECT id, gateway_id, chat_id, reply FROM turn_records
         WHERE started_at >= ? AND delivered_at = 0 AND reply <> '' AND gateway_id NOT LIKE 'web:%'
         ORDER BY started_at`,
      )
      .all(since)
      .map((row) => ({ id: row.id, gatewayId: row.gateway_id, chatId: row.chat_id, reply: row.reply }));
  }
}

export type DeliveryPort = Port<DeliveryStore>;
