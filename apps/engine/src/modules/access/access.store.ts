/**
 * Who may talk to the daemon.
 *
 * Three postures, and the default is the middle one because the other two are each wrong for a
 * different reason:
 *
 * - **`open`** — anyone who finds the bot can run the agent's tools. That was the previous behaviour
 *   whenever `sender_allowlist` was left empty, which is what a fresh install has.
 * - **`allowlist`** — ids in `config.toml`, and nothing else gets a reply. Correct, but adding a
 *   person means editing a file and restarting the daemon.
 * - **`pair`** — an unknown sender is told a short code and dropped; the operator approves the code
 *   and that sender is remembered. Adding someone is one command, and the decision is always an
 *   explicit human one.
 *
 * The identity is `(gatewayId, senderId)`. Not a bare sender id: a Telegram user id and a Discord
 * snowflake are both numeric strings, so bare ids can collide across platforms — and pairing with one
 * bot must not grant access to another bot on the same daemon.
 *
 * ## Four answers to a request, and only one of them is final
 *
 * - **approved** — they talk to the agent. `revoke` takes it back, and they may ask again.
 * - **denied** — no, *this time*. Silent until `denyCooldownMs` has passed (a day, as shipped), then a
 *   message from them is a new request with a new code. `reset` ends the wait early.
 * - **blocked** — no, until somebody says otherwise. Silent for good; `unblock` lets them ask again.
 * - **pending** — nobody has answered, and the code runs out.
 *
 * Deny used to be the block: a "no" pressed once at a code nobody recognised kept that person out for
 * ever, with nothing on any screen to say so.
 */

import { createLogger, type Port} from "@nouride/shared";
import { randomHex, type SqliteDb } from "@nouride/runtime";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("access");

export type AccessStatus = "pending" | "approved" | "denied" | "blocked";

/** Every audit action this store records — what the Access page's history reads. */
export const ACCESS_ACTIONS = [
  "access_requested",
  "access_approved",
  "access_denied",
  "access_blocked",
  "access_revoked",
  "access_reset",
  "access_unblocked",
  "access_expired",
] as const;
type AccessAction = (typeof ACCESS_ACTIONS)[number];

export interface SenderRecord {
  gatewayId: string;
  senderId: string;
  senderName: string | null;
  status: AccessStatus;
  code: string | null;
  chatId: string | null;
  requestedAt: number;
  /** Pending: when the code stops working. Denied: when they may ask again. Otherwise null. */
  expiresAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

interface Row {
  gateway_id: string;
  sender_id: string;
  sender_name: string | null;
  status: string;
  code: string | null;
  chat_id: string | null;
  requested_at: number;
  expires_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  last_notified_at: number | null;
}

/** What the pipeline should do with a message. */
export type AccessDecision =
  | { action: "allow" }
  /** Drop it and say nothing at all — `allowlist` mode, a denied sender still waiting, a blocked one. */
  | { action: "ignore"; reason: string }
  /** Drop it, but tell them the code once. */
  | { action: "pair"; code: string; expiresAt: number };

export interface AccessStoreOptions {
  db: SqliteDb;
  audit?: AuditLog;
  /** How long a pair code stays valid. */
  codeTtlMs: number;
  /** Minimum gap between "you are not authorized" replies to the same sender. */
  notifyCooldownMs: number;
  /** How long a denied sender waits before a message from them is a new request. */
  denyCooldownMs: number;
  now?: () => number;
}

/**
 * A code a human reads aloud and types correctly the first time.
 *
 * Crockford-ish alphabet: no `O`/`0`, `I`/`1` or `U`. Brute force is not the threat — approval takes
 * a deliberate operator action, and the code only identifies *which* pending request is being
 * answered. Being transcribable is the actual requirement.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";

export function generatePairCode(random: () => string = () => randomHex(8)): string {
  const source = random();
  let code = "";
  for (let i = 0; i < 6; i++) {
    const byte = Number.parseInt(source.slice(i * 2, i * 2 + 2) || "0", 16);
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export class AccessStore {
  constructor(private readonly options: AccessStoreOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Decide what to do with a message from `senderId` on `gatewayId`.
   *
   * `staticAllowlist` comes from config and is honoured in **every** mode: an operator who has
   * written an id down has already made the decision, and making them pair as well would be a
   * confusing second gate over the same question.
   *
   * **Except a block**, which comes first and holds in every mode. "Until somebody says otherwise" is
   * said on the Access page, and neither the open posture nor an id written in config.toml may walk past
   * it — a block that a line in a file quietly undid would be a block in name only.
   */
  check(params: {
    gatewayId: string;
    senderId: string;
    senderName?: string | undefined;
    chatId: string;
    mode: "open" | "allowlist" | "pair";
    staticAllowlist: readonly string[];
  }): AccessDecision {
    const existing = this.get(params.gatewayId, params.senderId);
    // Silent, as a denial is. Telling somebody they were turned away invites them to keep trying, and
    // tells them the bot is live.
    if (existing?.status === "blocked") return { action: "ignore", reason: "sender is blocked" };

    if (params.mode === "open") return { action: "allow" };

    if (this.matchesStatic(params.staticAllowlist, params.gatewayId, params.senderId)) {
      return { action: "allow" };
    }

    if (existing?.status === "approved") {
      this.refreshName(existing, params.senderName);
      return { action: "allow" };
    }
    if (existing?.status === "denied" && existing.expiresAt !== null && existing.expiresAt > this.now) {
      return { action: "ignore", reason: "sender was denied, and may ask again later" };
    }
    // A denial whose wait is over falls through: in pair mode they get a fresh code, as anybody new would.

    if (params.mode === "allowlist") {
      // Exactly what was asked for: not on the list, no reply at all.
      return { action: "ignore", reason: "not on the configured allowlist" };
    }

    // Pair mode, unknown sender. Reuse a live code so someone who writes three times gets one code
    // rather than three pending requests the operator has to sort out.
    const live =
      existing?.status === "pending" &&
      existing.code &&
      existing.expiresAt !== null &&
      existing.expiresAt > this.now
        ? existing
        : null;

    if (live?.code && live.expiresAt !== null) {
      if (!this.shouldNotify(params.gatewayId, params.senderId)) {
        return { action: "ignore", reason: "pair code already sent recently" };
      }
      this.markNotified(params.gatewayId, params.senderId);
      return { action: "pair", code: live.code, expiresAt: live.expiresAt };
    }

    const code = generatePairCode();
    const expiresAt = this.now + this.options.codeTtlMs;
    this.options.db
      .prepare(
        `INSERT INTO sender_access
           (gateway_id, sender_id, sender_name, status, code, chat_id, requested_at, expires_at,
            last_notified_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT(gateway_id, sender_id) DO UPDATE SET
           sender_name = excluded.sender_name,
           status = 'pending',
           code = excluded.code,
           chat_id = excluded.chat_id,
           requested_at = excluded.requested_at,
           expires_at = excluded.expires_at,
           last_notified_at = excluded.last_notified_at,
           resolved_at = NULL,
           resolved_by = NULL`,
      )
      .run(
        params.gatewayId,
        params.senderId,
        params.senderName ?? null,
        code,
        params.chatId,
        this.now,
        expiresAt,
        this.now,
      );

    this.options.audit?.record({
      action: "access_requested",
      actor: params.senderId,
      gatewayId: params.gatewayId,
      chatId: params.chatId,
      details: { sender: params.senderId, sender_name: params.senderName ?? null, code },
    });
    log.info("pair code issued", {
      gateway_id: params.gatewayId,
      sender: params.senderId,
      code,
    });

    return { action: "pair", code, expiresAt };
  }

  /**
   * Does a config entry cover this sender?
   *
   * Two spellings accepted: `telegram:nouva:123` (fully qualified) and a bare `123`. The bare form
   * exists because that is what an operator naturally writes, and it is scoped by the gateways they
   * have configured — but the qualified form is the one to reach for when the same daemon runs bots
   * on more than one platform.
   */
  private matchesStatic(
    allowlist: readonly string[],
    gatewayId: string,
    senderId: string,
  ): boolean {
    return allowlist.some(
      (entry) => entry === senderId || entry === `${gatewayId}:${senderId}`,
    );
  }

  /** Approve by code. Returns the record so the caller can tell them in the chat they used. */
  approveByCode(code: string, by: string): SenderRecord | null {
    const normalized = code.trim().toUpperCase();
    const row = this.options.db
      .prepare<Row>(
        `SELECT * FROM sender_access
         WHERE status = 'pending' AND code IS NOT NULL AND UPPER(code) = ? LIMIT 1`,
      )
      .get(normalized);
    if (!row) return null;

    // Expiry is checked at approval, not only at issue: a code that sat in a chat for a day should
    // not still work, and the operator gets told it expired rather than silently granting access.
    if (row.expires_at !== null && row.expires_at < this.now) return null;

    return this.resolve(row.gateway_id, row.sender_id, "approved", by);
  }

  /**
   * Answer a request: approve it or deny it. Only a request — an answer given from a page a minute old,
   * to somebody who has since been blocked, must not soften the block into a day's denial.
   */
  resolve(
    gatewayId: string,
    senderId: string,
    status: Extract<AccessStatus, "approved" | "denied">,
    by: string,
  ): SenderRecord | null {
    const before = this.get(gatewayId, senderId);
    if (before?.status !== "pending") return null;
    // A denial carries its own end, so the page can say when, and changing the setting later moves nobody's.
    const until = status === "denied" ? this.now + this.options.denyCooldownMs : null;
    this.options.db
      .prepare(
        `UPDATE sender_access
         SET status = ?, code = NULL, expires_at = ?, resolved_at = ?, resolved_by = ?
         WHERE gateway_id = ? AND sender_id = ?`,
      )
      .run(status, until, this.now, by, gatewayId, senderId);

    this.record(status === "approved" ? "access_approved" : "access_denied", by, before, {
      was: before.status,
      ...(until === null ? {} : { until }),
    });
    log.info("access resolved", { gateway_id: gatewayId, sender: senderId, status, by });

    return this.get(gatewayId, senderId);
  }

  /**
   * Keep somebody out until an operator lets them ask again: from a request, an approval or a denial,
   * or before they have written at all.
   */
  block(gatewayId: string, senderId: string, by: string): SenderRecord {
    const before = this.get(gatewayId, senderId);
    this.options.db
      .prepare(
        `INSERT INTO sender_access (gateway_id, sender_id, status, requested_at, resolved_at, resolved_by)
         VALUES (?, ?, 'blocked', ?, ?, ?)
         ON CONFLICT(gateway_id, sender_id) DO UPDATE SET
           status = 'blocked',
           code = NULL,
           expires_at = NULL,
           resolved_at = excluded.resolved_at,
           resolved_by = excluded.resolved_by`,
      )
      .run(gatewayId, senderId, this.now, this.now, by);
    const after = this.get(gatewayId, senderId)!;
    this.record("access_blocked", by, after, { was: before?.status ?? null });
    log.info("access blocked", { gateway_id: gatewayId, sender: senderId, by });
    return after;
  }

  /**
   * Let somebody in before they have asked. What `[security.access] allowlist` was the only way to do,
   * done where the Access page shows it, and Revoke and Block reach it — an id in config.toml can be
   * neither. Not past a block: that is unblocked first, on purpose. Approved already changes nothing
   * about access; a name given is still written, which is how a row let in nameless gets one.
   */
  allow(gatewayId: string, senderId: string, by: string, senderName?: string): SenderRecord | null {
    const before = this.get(gatewayId, senderId);
    if (before?.status === "blocked") return null;
    if (before?.status === "approved") {
      this.refreshName(before, senderName);
      return this.get(gatewayId, senderId);
    }
    this.options.db
      .prepare(
        `INSERT INTO sender_access (gateway_id, sender_id, sender_name, status, requested_at, resolved_at, resolved_by)
         VALUES (?, ?, ?, 'approved', ?, ?, ?)
         ON CONFLICT(gateway_id, sender_id) DO UPDATE SET
           status = 'approved',
           code = NULL,
           expires_at = NULL,
           sender_name = COALESCE(excluded.sender_name, sender_access.sender_name),
           resolved_at = excluded.resolved_at,
           resolved_by = excluded.resolved_by`,
      )
      .run(gatewayId, senderId, senderName ?? null, this.now, this.now, by);
    const after = this.get(gatewayId, senderId)!;
    this.record("access_approved", by, after, { was: before?.status ?? null, asked: false });
    log.info("access allowed", { gateway_id: gatewayId, sender: senderId, by });
    return after;
  }

  /** Take an approval back. They may ask again: this is not a block. */
  revoke(gatewayId: string, senderId: string, by: string): boolean {
    return this.release(gatewayId, senderId, by, "approved", "access_revoked");
  }

  /** End a denial's wait now: their next message is a new request. */
  reset(gatewayId: string, senderId: string, by: string): boolean {
    return this.release(gatewayId, senderId, by, "denied", "access_reset");
  }

  /** Lift a block. Their next message is a new request, not a way in. */
  unblock(gatewayId: string, senderId: string, by: string): boolean {
    return this.release(gatewayId, senderId, by, "blocked", "access_unblocked");
  }

  /**
   * Forget a sender who is in one state, and only that one.
   *
   * The state is part of the question so an answer given from a page a minute old cannot do something
   * else: Revoke pressed on an approval somebody has since turned into a block must not lift the block.
   */
  private release(gatewayId: string, senderId: string, by: string, status: AccessStatus, action: AccessAction): boolean {
    const before = this.get(gatewayId, senderId);
    if (before?.status !== status) return false;
    this.options.db
      .prepare("DELETE FROM sender_access WHERE gateway_id = ? AND sender_id = ? AND status = ?")
      .run(gatewayId, senderId, status);
    this.record(action, by, before);
    log.info("access released", { gateway_id: gatewayId, sender: senderId, was: status, by });
    return true;
  }

  /**
   * The name a platform reports for an approved sender, kept as it is now: somebody let in by `allow`
   * has no name until they write, and people rename themselves. Display only — never matched — and
   * written only when it changed, so an unchanged name costs a message nothing.
   */
  private refreshName(sender: SenderRecord, name: string | undefined): void {
    if (!name || name === sender.senderName) return;
    this.options.db
      .prepare("UPDATE sender_access SET sender_name = ? WHERE gateway_id = ? AND sender_id = ?")
      .run(name, sender.gatewayId, sender.senderId);
  }

  /** One line of the access history: who did it, and to whom, by name as well as id while it is known. */
  private record(action: AccessAction, by: string, sender: SenderRecord, details: Record<string, unknown> = {}): void {
    this.options.audit?.record({
      action,
      actor: by,
      gatewayId: sender.gatewayId,
      details: { sender: sender.senderId, sender_name: sender.senderName, ...details },
    });
  }

  get(gatewayId: string, senderId: string): SenderRecord | null {
    const row = this.options.db
      .prepare<Row>("SELECT * FROM sender_access WHERE gateway_id = ? AND sender_id = ?")
      .get(gatewayId, senderId);
    return row ? toRecord(row) : null;
  }

  list(status?: AccessStatus): SenderRecord[] {
    const rows = status
      ? this.options.db
          .prepare<Row>("SELECT * FROM sender_access WHERE status = ? ORDER BY requested_at DESC")
          .all(status)
      : this.options.db
          .prepare<Row>("SELECT * FROM sender_access ORDER BY requested_at DESC")
          .all();
    return rows.map(toRecord);
  }

  /**
   * Put away what has run out. Returns how many rows went.
   *
   * - **A request whose code expired** goes, and is recorded as expired, so the history shows a request
   *   nobody answered rather than one that vanished. Left, the pending list fills with codes that would
   *   be refused anyway and the useful signal is buried.
   * - **A denial whose wait is over** goes: their next message is a new request either way (`check`).
   *
   * At boot, and before the list is read.
   */
  tidy(): number {
    const now = this.now;
    const expired = this.options.db
      .prepare<Row>("SELECT * FROM sender_access WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
      .all(now);
    for (const row of expired) this.record("access_expired", "system", toRecord(row));
    const changed = this.options.db
      .prepare(
        `DELETE FROM sender_access
         WHERE status IN ('pending', 'denied') AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .run(now).changes;
    if (changed > 0) log.info("expired requests and finished denials put away", { count: changed });
    return changed;
  }

  private shouldNotify(gatewayId: string, senderId: string): boolean {
    const row = this.options.db
      .prepare<{ last_notified_at: number | null }>(
        "SELECT last_notified_at FROM sender_access WHERE gateway_id = ? AND sender_id = ?",
      )
      .get(gatewayId, senderId);
    const last = row?.last_notified_at;
    return last === null || last === undefined || this.now - last >= this.options.notifyCooldownMs;
  }

  private markNotified(gatewayId: string, senderId: string): void {
    this.options.db
      .prepare(
        "UPDATE sender_access SET last_notified_at = ? WHERE gateway_id = ? AND sender_id = ?",
      )
      .run(this.now, gatewayId, senderId);
  }
}

function toRecord(row: Row): SenderRecord {
  return {
    gatewayId: row.gateway_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    status: row.status as AccessStatus,
    code: row.code,
    chatId: row.chat_id,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

/**
 * What an unknown sender is told.
 *
 * Deliberately says nothing about the agent's capabilities or who the operator is. A stranger gets a
 * code and a fact; anything more is reconnaissance handed out for free.
 *
 * **Where to approve it is the one exception**, and it was added because the message without it is a
 * dead end for the most common case there is: the person pairing *is* the operator, setting up their
 * own bot. "Send that code to whoever runs me" is an instruction they cannot follow when they are
 * that person and nothing has told them there is a page for it. The disclosure is that a dashboard
 * exists, which is on the project's front page.
 *
 * One page for every agent's requests, so the path names no agent: admission runs *before* routing and
 * may not know which one this becomes. No duration is quoted: `codeTtlMs` is configurable, and a
 * message that says fifteen minutes on a daemon set to five is worse than one that says neither.
 */
export function pairMessage(code: string): string {
  return [
    "I do not know you yet, so I am not going to act on that.",
    "",
    `Pairing code: **${code}**`,
    "",
    "Send that code to whoever runs me. Once they approve it, message me again.",
    "",
    `**If that is you:** open the dashboard, go to Access, and approve **${code}** under Pending. ` +
      "Codes expire, so approve it while it is still listed there.",
  ].join("\n");
}

/**
 * Who may talk to this daemon, as the daemon depends on it.
 *
 * Business logic takes this, never `AccessStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type AccessPort = Port<AccessStore>;
