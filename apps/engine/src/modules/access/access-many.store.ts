/**
 * The access store's two operations over many senders at once: a whole list let in ahead, and the listing a page
 * or a terminal reads, bounded. Apart from `access.store.ts`, which is about one sender and one answer, and reached
 * through it.
 */

import { createLogger } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { AccessStatus, Row } from "./access.store.ts";

const log = createLogger("access");

/** How many approved senders one listing holds, the newest first (`listedRows`). */
export const APPROVED_LISTED = 500;

/**
 * Many let in ahead at once, from a list (`nouride access allow --from`): each as `allow` lets one in, in one
 * write. Not past a block, and one approved already is left as it is, its name filled in where it had none.
 * `dryRun` counts and writes nothing. One line in the history for the whole list: ten thousand lines of it would
 * bury every answer a person gave.
 */
export function allowMany(
  on: { db: SqliteDb; audit: AuditPort | undefined; now: number },
  gatewayId: string,
  senders: readonly { senderId: string; name?: string }[],
  by: string,
  dryRun: boolean,
): { added: number; already: number; blocked: number } {
  const standing = new Map(
    on.db.prepare<{ sender_id: string; status: string }>("SELECT sender_id, status FROM sender_access WHERE gateway_id = ?").all(gatewayId).map((row) => [row.sender_id, row.status] as const),
  );
  const counts = { added: 0, already: 0, blocked: 0 };
  const add = senders.filter((sender) => {
    const now = standing.get(sender.senderId);
    if (now === "blocked") counts.blocked += 1;
    else if (now === "approved") counts.already += 1;
    else counts.added += 1;
    return now !== "blocked";
  });
  if (dryRun) return counts;
  const at = on.now;
  const put = on.db.prepare(
    `INSERT INTO sender_access (gateway_id, sender_id, sender_name, status, requested_at, resolved_at, resolved_by)
     VALUES (?, ?, ?, 'approved', ?, ?, ?)
     ON CONFLICT(gateway_id, sender_id) DO UPDATE SET
       status = 'approved',
       code = NULL,
       expires_at = NULL,
       sender_name = COALESCE(sender_access.sender_name, excluded.sender_name),
       resolved_at = CASE WHEN sender_access.status = 'approved' THEN sender_access.resolved_at ELSE excluded.resolved_at END,
       resolved_by = CASE WHEN sender_access.status = 'approved' THEN sender_access.resolved_by ELSE excluded.resolved_by END`,
  );
  on.db.transaction(() => {
    for (const sender of add) put.run(gatewayId, sender.senderId, sender.name?.trim() || null, at, at, by);
  });
  on.audit?.record({ action: "access_imported", actor: by, gatewayId, details: { ...counts } });
  log.info("a list of senders allowed", { gateway_id: gatewayId, by, ...counts });
  return counts;
}

/**
 * The senders as a page or a terminal lists them: everyone asking, denied or blocked, and of the approved the
 * newest `APPROVED_LISTED`, with how many there are in all. A list let in from a file may be ten thousand, and the
 * dashboard asks again every fifteen seconds. `find` narrows the approved to those whose id or name holds it, which
 * is how one beyond the newest is reached.
 */
export function listedRows(db: SqliteDb, status?: AccessStatus, find?: string): { rows: Row[]; approvedTotal: number; approvedOn: Record<string, number> } {
  // How many on each connection too: a page that leaves some connections out (an agent open to everyone, an agent
  // picked) counts the rest from these, not from the newest it was sent.
  const approvedOn = Object.fromEntries(
    db.prepare<{ gateway_id: string; n: number }>("SELECT gateway_id, COUNT(*) AS n FROM sender_access WHERE status = 'approved' GROUP BY gateway_id").all().map((row) => [row.gateway_id, row.n]),
  );
  const approvedTotal = Object.values(approvedOn).reduce((sum, n) => sum + n, 0);
  const needle = find?.trim() ? `%${find.trim().replace(/[\\%_]/g, (mark) => `\\${mark}`)}%` : null;
  const approved =
    status && status !== "approved"
      ? []
      : needle
        ? db
            .prepare<Row>(`SELECT * FROM sender_access WHERE status = 'approved' AND (sender_id LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\') ORDER BY resolved_at DESC, sender_id LIMIT ?`)
            .all(needle, needle, APPROVED_LISTED)
        : db.prepare<Row>("SELECT * FROM sender_access WHERE status = 'approved' ORDER BY resolved_at DESC, sender_id LIMIT ?").all(APPROVED_LISTED);
  const rest =
    status === "approved"
      ? []
      : status
        ? db.prepare<Row>("SELECT * FROM sender_access WHERE status = ? ORDER BY requested_at DESC").all(status)
        : db.prepare<Row>("SELECT * FROM sender_access WHERE status != 'approved' ORDER BY requested_at DESC").all();
  return { rows: [...rest, ...approved], approvedTotal, approvedOn };
}
