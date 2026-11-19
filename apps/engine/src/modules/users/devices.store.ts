/**
 * Device tokens (`device_tokens`, migration 091): what a Home app on the daemon's own machine holds so that it never
 * lands on the dashboard's sign-in. A session lives a fixed week; a device token does not expire, and is traded for a
 * fresh ordinary session whenever the app is answered 401.
 *
 * Made only through the control token (`nouride auth device`), which is the proof that whoever asks can read the
 * data folder, and bound to the first admin when it is made. Never a request from loopback: on a phone every app
 * reaches 127.0.0.1. Only its SHA-256 is kept; the value is shown once, to whoever made it.
 */

import { newId, type Port } from "@nouride/shared";
import { randomBytes, sha256Text, type SqliteDb } from "@nouride/runtime";
import type { DeviceTokenView } from "@nouride/wire";

/** Every device token's value starts with it, so one pasted where a password goes is told apart at once. */
const PREFIX = "ndev_";

interface Row {
  id: string;
  user_id: string;
  username: string | null;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

const toView = (row: Row): DeviceTokenView => ({
  id: row.id,
  label: row.label,
  userId: row.user_id,
  username: row.username ?? "",
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const LIVE = `SELECT d.id, d.user_id, u.username, d.label, d.created_at, d.last_used_at
  FROM device_tokens d JOIN users u ON u.id = d.user_id WHERE d.revoked_at IS NULL`;

export class DeviceTokenStore {
  constructor(private readonly db: SqliteDb) {}

  /** The account a new device token is bound to: the admin made first. Null on an install with no admin yet. */
  firstAdmin(): { id: string; username: string } | null {
    return this.db.prepare<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'admin' ORDER BY created_at, rowid LIMIT 1").get() ?? null;
  }

  /** A new token for `userId`; `value` is the only time it exists outside the app that holds it. */
  create(input: { userId: string; label: string; now: number }): { device: DeviceTokenView; value: string } {
    const id = newId("dev");
    const value = `${PREFIX}${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare("INSERT INTO device_tokens (id, token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, sha256Text(value), input.userId, input.label, input.now);
    return { device: this.get(id)!, value };
  }

  /** The live token this value is, marked used; null for anything else (revoked, unknown, its account gone). */
  use(value: string, now: number): DeviceTokenView | null {
    if (!value.startsWith(PREFIX)) return null;
    const row = this.db.prepare<Row>(`${LIVE} AND d.token_hash = ?`).get(sha256Text(value));
    if (!row) return null;
    this.db.prepare("UPDATE device_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return toView({ ...row, last_used_at: now });
  }

  get(id: string): DeviceTokenView | null {
    const row = this.db.prepare<Row>(`${LIVE} AND d.id = ?`).get(id);
    return row ? toView(row) : null;
  }

  list(): DeviceTokenView[] {
    return this.db.prepare<Row>(`${LIVE} ORDER BY d.created_at, d.rowid`).all().map(toView);
  }

  /** Revoked, and the sessions it was traded for ended with it: the app is signed out now, not in a week. */
  revoke(id: string, now: number): boolean {
    return this.db.transaction(() => {
      const revoked = this.db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
      if (revoked) this.db.prepare("DELETE FROM user_sessions WHERE device_id = ?").run(id);
      return revoked;
    });
  }
}

export type DeviceTokenPort = Port<DeviceTokenStore>;
