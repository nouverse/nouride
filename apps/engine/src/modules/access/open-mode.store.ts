/**
 * Who already writes to an install's agents, read once: for an install brought forward from `open` for everyone
 * (`boot/open-mode.ts`), where each of them is then let in by name.
 *
 * A turn's record keeps the connection it came on and who sent the message that began it, so everyone here has been
 * answered by an agent at least once and their conversation has not aged out. Read whole: it runs once, at an upgrade.
 */

import type { SqliteDb } from "@nouride/runtime";

export class OpenModeStore {
  constructor(private readonly db: SqliteDb) {}

  /** Each connection's senders whose message began a turn the install still holds. */
  senders(): { gatewayId: string; senderId: string }[] {
    return this.db
      .prepare<{ gatewayId: string; senderId: string }>("SELECT DISTINCT gateway_id AS gatewayId, sender_id AS senderId FROM turn_records WHERE sender_id IS NOT NULL AND sender_id != '' ORDER BY gateway_id, sender_id")
      .all();
  }
}
