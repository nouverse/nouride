/**
 * "Stop asking me" — a standing decision about a person, not a conversation.
 *
 * The friction this removes was measured on a phone: scaffolding a small project is a dozen `write`
 * requests, each with a 24-character id to copy back. The operator mistyped one, got "not waiting for
 * an answer any more", and had to hunt for the right id in a wall of text. A gate that expensive to
 * answer is one people route around — by disabling approval globally, which is a far worse outcome.
 *
 * ## Keyed by sender, and persisted
 *
 * Pairing already establishes that a person is trusted. This is the second half of the same sentence:
 * *and I do not want to be asked every time*. So it follows the **sender**, not the chat — a
 * conversation-scoped switch had to be re-said after `/new`, after `/reset`, and in every other
 * channel, which is the friction it was supposed to remove.
 *
 * `(gatewayId, senderId)` and not a bare sender id: a Telegram user id and a Discord snowflake are
 * both numeric strings, so bare ids collide across platforms. Trusting someone on one bot must not
 * silently trust whoever holds that number on another.
 *
 * In SQLite rather than memory, because "until you restart" is not what anyone means by "stop asking
 * me". `/reset` does not clear it either — a reset puts a *conversation* back to how it started, and
 * this is not conversation state.
 *
 * ## What it does not cover
 *
 * What still asks is the set that *changes or removes* something: recursive deletes, system control,
 * infrastructure mutations. Elevation on its own no longer does — `sudo cat` is friction, and friction
 * is what gets a gate switched off wholesale — but only because `classifyHardline` looks *through* an
 * elevation now, so `sudo rm -rf` is a delete rather than a `sudo`. That ordering is load-bearing.
 * On this very install an agent with `exec` ran `systemctl restart nouride` and
 * `kill -SIGTERM` on its own pid — deliberately, mid-conversation — and took itself down. "Stop
 * asking about my file writes" and "let it run sudo unattended" are different sentences, and only the
 * first one is being said here.
 */

import type { ApprovalLevel } from "@nouride/shared";
import { createLogger, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("tools.auto-approve");

export interface AutoApproveOptions {
  db: SqliteDb;
  audit?: AuditLog;
  now?: () => number;
}

export class AutoApprove {
  constructor(private readonly options: AutoApproveOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * This person's level, or nothing if they have not set one.
   *
   * The table still holds a boolean row per `(gateway, sender)`, because that is what an existing
   * install has and there is nothing to migrate: a row means the person said "stop asking me", which is
   * `balanced`. Nobody can be at `trusted` through this store — `trusted` has no unauthenticated write path at
   * all, by design (see `@nouride/policy`'s `approvals.ts`).
   */
  levelFor(gatewayId: string, senderId: string): ApprovalLevel | undefined {
    return this.enabled(gatewayId, senderId) ? "balanced" : undefined;
  }

  /** Turn it on for a sender. Returns false when it was already on. */
  enable(gatewayId: string, senderId: string, by: string): boolean {
    if (this.enabled(gatewayId, senderId)) return false;

    this.options.db
      .prepare(
        `INSERT INTO auto_approve (gateway_id, sender_id, enabled_at, enabled_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(gateway_id, sender_id) DO UPDATE SET enabled_at = excluded.enabled_at`,
      )
      .run(gatewayId, senderId, this.now, by);

    // Audited *and* logged at warn. A row that switches a gate off is the first thing anyone reading
    // back wants to find, and the audit table is where "who did this, and when" has to be answerable.
    log.warn("auto-approval enabled for a sender", { gateway: gatewayId, sender: senderId, by });
    this.options.audit?.record({
      action: "auto_approve_enabled",
      actor: by,
      gatewayId,
      details: { sender: senderId },
    });
    return true;
  }

  /** Turn it off. Returns false when it was not on. */
  disable(gatewayId: string, senderId: string, by: string): boolean {
    const result = this.options.db
      .prepare("DELETE FROM auto_approve WHERE gateway_id = ? AND sender_id = ?")
      .run(gatewayId, senderId);
    if (Number(result.changes ?? 0) === 0) return false;

    log.info("auto-approval disabled", { gateway: gatewayId, sender: senderId });
    this.options.audit?.record({
      action: "auto_approve_disabled",
      actor: by,
      gatewayId,
      details: { sender: senderId },
    });
    return true;
  }

  /**
   * Consulted on every gated tool call.
   *
   * A prepared read against a primary key, which is microseconds — and it sits in a loop that is
   * already waiting on a network round trip. Caching it would buy nothing and would have to be
   * invalidated when the operator changes their mind, which is the part that goes wrong.
   */
  enabled(gatewayId: string, senderId: string): boolean {
    const row = this.options.db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM auto_approve WHERE gateway_id = ? AND sender_id = ?",
      )
      .get(gatewayId, senderId);
    return (row?.n ?? 0) > 0;
  }

  /**
   * Drop it when a sender loses access.
   *
   * Revoking someone's access and leaving their standing "never ask about me" behind would mean it
   * came back the moment they were paired again — a decision nobody re-made.
   */
  forget(gatewayId: string, senderId: string): void {
    this.options.db
      .prepare("DELETE FROM auto_approve WHERE gateway_id = ? AND sender_id = ?")
      .run(gatewayId, senderId);
  }
}

/**
 * "stop asking me", per sender, as the daemon depends on it.
 *
 * Business logic takes this, never `AutoApprove` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type AutoApprovePort = Port<AutoApprove>;
