/**
 * Dashboard accounts and their sessions.
 *
 * `users` and `user_sessions` were declared in the very first migration and had no code behind them
 * for the whole of Phase 1 — a schema that describes a feature nobody wrote. This is that feature.
 *
 * Separate from the control token rather than replacing it. The token is a machine credential that the
 * CLI reads off disk with `0600` on it; an account is a person. Both reach the same routes, because the
 * alternative is a second copy of every route with a different guard on it, and two copies of an
 * authorisation rule is how one of them ends up wrong.
 */

import { createLogger, newId, type Port} from "@nouride/shared";
import { hashPassword, passwordNeedsRehash, randomToken, sha256Text, verifyPassword, type SqliteDb } from "@nouride/runtime";
import type { AuditPort } from "@/commons/audit.store.ts";

const log = createLogger("users");

/**
 * What each role may do.
 *
 * `viewer` is read-only: it can watch, and that is all. `operator` runs the daemon — chat, approvals,
 * agents, files — but cannot create accounts or hand out roles, because the ability to mint an admin is
 * the ability to become one. `admin` is both.
 */
export type UserRole = "admin" | "operator" | "viewer";

const USER_ROLES: readonly UserRole[] = ["admin", "operator", "viewer"];

/**
 * Not exported, and that is the multi-user boundary showing.
 *
 * Validating a role that arrived over the wire is something only a daemon that can be
 * *asked* to change one does, and that daemon is the one carrying `internals/pro/multi-user` —
 * which declares the same three strings and does the validating there. What is left here
 * is reading a role back out of a row, where the only question is whether the database
 * says something this build understands.
 */
function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  created_at: number;
  updated_at: number;
  must_change_password: number;
  last_login_at: number | null;
}

export interface UserRecord {
  id: string;
  username: string;
  /** What to call them. Empty means nobody has said — not "fall back to the username". */
  displayName: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  /**
   * Whether this account can be signed into with a password at all.
   *
   * False for an account added by email alone, which signs in through the
   * identity provider and nothing else. Derived from the stored value rather
   * than a column of its own — see {@link NO_PASSWORD}.
   *
   * Reported so the Users page can say so. An account listed identically to the
   * others but unable to use the password field is a support question.
   */
  hasPassword: boolean;
}

/** Never carries the hash. A record that cannot leak a credential cannot leak one by accident. */
function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? "",
    role: isUserRole(row.role) ? row.role : "viewer",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: row.last_login_at,
    hasPassword: row.password_hash !== NO_PASSWORD,
  };
}

/**
 * Usernames are compared lowercased.
 *
 * Two accounts differing only in case are indistinguishable to the person typing one, and the unique
 * index cannot see the difference either — so the normalisation happens here, once, rather than at each
 * call site where forgetting it creates a duplicate nobody can log in to.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A week. Long enough that a dashboard left open overnight still works, short enough to expire. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What `password_hash` holds for an account that has none.
 *
 * Borrowed from `/etc/shadow`, where `!` in the password field means exactly
 * this. Chosen because it cannot be the output of any hash function this daemon
 * uses, so it can never be mistaken for one — an empty string could plausibly
 * be produced by a bug, and a bug that made empty verify would be an open door.
 *
 * Deliberately not a schema change. "Has a password" is a property of the value
 * already stored; a second column would be a second thing that can disagree
 * with it.
 */
export const NO_PASSWORD = "!";

/**
 * The shortest password accepted.
 *
 * Deliberately a length floor and nothing else: composition rules ("one symbol, one digit") are known
 * to produce worse passwords, and this daemon is not the place to relitigate that.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** How a password is hashed and checked — the runtime's argon2id unless a test passes a cheaper one. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  /** Whether a hash that verified was made at another cost than `hash` makes — and so is made again at sign-in. */
  needsRehash(hash: string): boolean;
}

const ARGON2ID: PasswordHasher = {
  hash: (password) => hashPassword(password),
  verify: verifyPassword,
  needsRehash: (hash) => passwordNeedsRehash(hash),
};

export interface UserStoreOptions {
  db: SqliteDb;
  audit?: AuditPort;
  now?: () => number;
  /**
   * For tests: a hasher at a lower cost. Absent — always, in the daemon — it is the runtime's own. A test that signs in
   * forty times paid three seconds for it at the real cost (`hashPassword`).
   */
  passwords?: PasswordHasher;
}

export class UserStore {
  /**
   * A valid hash of a value nobody knows, verified against when the username does not exist — made by this store's
   * hasher, so a missing account costs what a wrong password does whatever the hasher is.
   */
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly options: UserStoreOptions) {}

  private get passwords(): PasswordHasher {
    return this.options.passwords ?? ARGON2ID;
  }

  /**
   * Generated on first use rather than hard-coded, so this file never contains something that looks like a credential —
   * a literal hash in source reads as a backdoor to every reviewer who finds it — and lazily, on a path that only runs
   * when a login has already failed.
   */
  private unknownUserHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(randomToken());
    return this.dummyHash;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  count(): number {
    const row = this.options.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM users")
      .get();
    return row?.n ?? 0;
  }

  list(): UserRecord[] {
    return this.options.db
      .prepare<UserRow>("SELECT * FROM users ORDER BY created_at")
      .all()
      .map(toRecord);
  }

  byId(id: string): UserRecord | null {
    const row = this.options.db.prepare<UserRow>("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  byUsername(username: string): UserRecord | null {
    const row = this.options.db
      .prepare<UserRow>("SELECT * FROM users WHERE username = ?")
      .get(normalizeUsername(username));
    return row ? toRecord(row) : null;
  }

  async create(input: {
    username: string;
    /**
     * Omit — or pass empty — for an account that has no password at all.
     *
     * For an install that signs people in through an identity provider, a
     * password is a second way in that nobody uses and everybody has to keep
     * secret. An account added by email alone has none: `password_hash` holds
     * {@link NO_PASSWORD}, `verify` refuses it outright, and the only way in is
     * the provider. `setPassword` still works, so this is reversible.
     */
    password?: string;
    role: UserRole;
    createdBy: string;
    mustChangePassword?: boolean;
  }): Promise<UserRecord> {
    const username = normalizeUsername(input.username);
    if (!username) throw new Error("username is required");
    if (!/^[a-z0-9._@+-]+$/.test(username)) {
      throw new Error("username may contain letters, digits, dot, dash, underscore, @ and +");
    }
    const wantsPassword = (input.password ?? "").length > 0;
    if (wantsPassword && input.password!.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (this.byUsername(username)) throw new Error(`user "${username}" already exists`);

    const id = newId("usr");
    const at = this.now();
    this.options.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, created_at, updated_at,
                            must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        username,
        wantsPassword ? await this.passwords.hash(input.password!) : NO_PASSWORD,
        input.role,
        at,
        at,
        // Meaningless without one, and worse than meaningless: it would send the
        // account to the change-password screen it can never satisfy.
        wantsPassword && input.mustChangePassword ? 1 : 0,
      );

    log.info("dashboard user created", {
      user: username,
      role: input.role,
      password_login: wantsPassword ? "set" : "none (provider sign-in only)",
    });
    this.options.audit?.record({
      action: "user_created",
      actor: input.createdBy,
      details: { username, role: input.role },
    });

    return this.byId(id) as UserRecord;
  }

  /**
   * Check a username and password.
   *
   * Returns null for both "no such user" and "wrong password", and **hashes anyway** when the user does
   * not exist. Answering an unknown username faster than a wrong password turns this endpoint into a
   * way to enumerate accounts, and the cost of the extra hash is paid only on failures.
   */
  async verify(username: string, password: string): Promise<UserRecord | null> {
    const row = this.options.db
      .prepare<UserRow>("SELECT * FROM users WHERE username = ?")
      .get(normalizeUsername(username));

    if (!row) {
      await this.passwords.verify(password, await this.unknownUserHash());
      return null;
    }
    /**
     * An account with no password cannot be signed into with one.
     *
     * **Belt and braces, and measured as such**: `verifyPassword` already
     * answers false for an unparseable hash — it catches and returns false
     * rather than throwing — so removing this block breaks no test today. It
     * stays because that behaviour is one `catch` in `packages/runtime`
     * away from changing, and the failure mode if it ever did is an account
     * that anything signs into. `crypto.test.ts` pins the assumption; this
     * refuses regardless of it.
     *
     * Placed after the same dummy hash an unknown username pays, so a
     * passwordless account and a nonexistent one are indistinguishable in time.
     */
    if (row.password_hash === NO_PASSWORD) {
      await this.passwords.verify(password, await this.unknownUserHash());
      return null;
    }
    if (!(await this.passwords.verify(password, row.password_hash))) return null;

    const at = this.now();
    this.options.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, row.id);
    /**
     * A hash made at another cost is made again, now that the password is known — the one moment it is.
     *
     * 0.7.11 lowered the cost from Bun's 64 MiB to OWASP's 19 MiB (`hashPassword`); an account made before keeps its old
     * hash, which still verifies, and pays the 64 MiB at every sign-in until this replaces it. Not `updated_at`: nobody
     * changed the account. And not `setPassword`, which would end every other session the person has open.
     */
    if (this.passwords.needsRehash(row.password_hash)) {
      this.options.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await this.passwords.hash(password), row.id);
      log.info("dashboard password hashed again at the current cost", { user: row.id });
    }
    return toRecord({ ...row, last_login_at: at });
  }

  async setPassword(id: string, password: string, actor: string): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const at = this.now();
    this.options.db
      .prepare(
        `UPDATE users SET password_hash = ?, updated_at = ?, must_change_password = 0 WHERE id = ?`,
      )
      .run(await this.passwords.hash(password), at, id);

    log.info("dashboard password changed", { user: id });
    this.options.audit?.record({ action: "user_password_changed", actor, details: { user: id } });
  }

  /**
   * Change the handle an account logs in with.
   *
   * Refused rather than silently ignored when the name is taken, because the caller who gets a success
   * back for a rename that did not happen goes on to sign in with the new name and cannot.
   */
  setUsername(id: string, raw: string, actor: string): { ok: true } | { ok: false; error: string } {
    const username = normalizeUsername(raw);
    if (!username) return { ok: false, error: "username is required" };
    if (!/^[a-z0-9._@+-]+$/.test(username)) {
      return { ok: false, error: "username may contain letters, digits, dot, dash, underscore, @ and +" };
    }

    const taken = this.byUsername(username);
    if (taken && taken.id !== id) return { ok: false, error: `user "${username}" already exists` };
    if (taken) return { ok: true };

    this.options.db
      .prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = ?")
      .run(username, this.now(), id);

    log.info("dashboard username changed", { user: id, username });
    this.options.audit?.record({
      action: "user_username_changed",
      actor,
      details: { user: id, username },
    });
    return { ok: true };
  }

  /** Trimmed, and an empty string is stored as one — see the migration for why that is a real value. */
  setDisplayName(id: string, raw: string, actor: string): void {
    const displayName = raw.trim().slice(0, 80);
    this.options.db
      .prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName, this.now(), id);
    this.options.audit?.record({
      action: "user_name_changed",
      actor,
      details: { user: id, name: displayName },
    });
  }

  setRole(id: string, role: UserRole, actor: string): void {
    this.options.db
      .prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
      .run(role, this.now(), id);
    this.options.audit?.record({ action: "user_role_changed", actor, details: { user: id, role } });
  }

  /**
   * Remove an account.
   *
   * Refuses the last admin. An instance with no admin cannot create one from the dashboard — the only
   * remedy is editing the database by hand, which is precisely the terminal step this whole surface
   * exists to remove.
   */
  delete(
    id: string,
    actor: string,
    /**
     * The account making the request, when a person is making it.
     *
     * Absent for the control token, which is the CLI on the operator's own machine: it has no
     * account to lock itself out of, and refusing it would leave a daemon whose last admin account
     * is unreachable with no way to clear it.
     */
    callerId?: string,
  ): { ok: true } | { ok: false; reason: string; why: "missing" | "own" | "last-admin" } {
    const user = this.byId(id);
    if (!user) return { ok: false, reason: "no such user", why: "missing" };

    /**
     * Nobody deletes their own account, admin or not.
     *
     * The only guard here was `adminCount() <= 1`, which catches this by accident and only when it
     * happens to be true: with two admins, an admin could delete themselves and be signed out of a
     * daemon they still administer, with the row gone and no way back in from that browser. The
     * last-admin rule is about the daemon keeping an administrator; this one is about a person not
     * removing their own way in, and they are different rules that happened to overlap.
     */
    if (callerId && callerId === id) {
      return { ok: false, reason: "you cannot delete your own account. Ask another admin to do it", why: "own" };
    }

    if (user.role === "admin" && this.adminCount() <= 1) {
      return { ok: false, reason: "this is the only admin. Promote another account first", why: "last-admin" };
    }

    this.options.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    log.info("dashboard user deleted", { user: user.username });
    this.options.audit?.record({
      action: "user_deleted",
      actor,
      details: { username: user.username },
    });
    return { ok: true };
  }

  adminCount(): number {
    const row = this.options.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get();
    return row?.n ?? 0;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  /**
   * Mint a session token. The caller sets it as an httpOnly cookie; nothing else ever sees it.
   *
   * Only its SHA-256 is kept, as an MCP token's is, and a token is found by hashing it. The database goes into every
   * snapshot, a USB drive's included: a row a copy holds is not a cookie anybody can present.
   */
  startSession(userId: string): { token: string; expiresAt: number } {
    const token = randomToken();
    const at = this.now();
    const expiresAt = at + SESSION_TTL_MS;
    this.options.db
      .prepare(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId("uss"), userId, sha256Text(token), expiresAt, at);
    this.sweepExpiredSessions();
    return { token, expiresAt };
  }

  /**
   * The account behind a session token, or null.
   *
   * Expired rows are deleted as they are found rather than on a timer. A sweep needs something to run
   * it, and the lookup is already touching the row that proves it is stale.
   */
  sessionUser(token: string): UserRecord | null {
    if (!token) return null;
    const hash = sha256Text(token);
    const row = this.options.db
      .prepare<{ user_id: string; expires_at: number }>(
        "SELECT user_id, expires_at FROM user_sessions WHERE token_hash = ?",
      )
      .get(hash);
    if (!row) return null;

    if (row.expires_at <= this.now()) {
      this.options.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    return this.byId(row.user_id);
  }

  endSession(token: string): void {
    this.options.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(sha256Text(token));
  }

  /**
   * Drop every session for one account.
   *
   * Called on a password change: the reason someone changes a password is often that they believe
   * somebody else has it, and leaving that person's session alive answers the wrong half of the problem.
   */
  endAllSessions(userId: string): void {
    this.options.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
  }

  /**
   * Every account and every session, in one transaction — the setup console's "Reset accounts" on a box, after
   * which the next start offers the card's first sign-in again. Asked of the daemon that owns the database; the
   * plugin used to open the file and delete the rows itself, beside a daemon writing it.
   */
  resetAll(): number {
    const db = this.options.db;
    return db.transaction(() => {
      db.prepare("DELETE FROM user_sessions").run();
      return db.prepare("DELETE FROM users").run().changes;
    });
  }

  /**
   * The expired sessions nobody will present again — run at every sign-in.
   *
   * `sessionUser` deletes an expired row when its token comes back, which never happens for a browser that
   * was closed for good, so those rows stayed. Swept here they are bounded by what expired since the last
   * sign-in, with no timer to run it: an index range delete on a table this small costs nothing.
   */
  sweepExpiredSessions(): number {
    return this.options.db
      .prepare("DELETE FROM user_sessions WHERE expires_at <= ?")
      .run(this.now()).changes;
  }
}


/**
 * Dashboard accounts and sessions, as the daemon depends on it.
 *
 * Business logic takes this, never `UserStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type UsersPort = Port<UserStore>;
