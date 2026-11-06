/**
 * Dashboard accounts: the store, the bootstrap, and who is allowed to do what.
 *
 * This is the surface that decides whether a published port is a dashboard or a shell, so the cases
 * worth writing down are the refusals — a wrong password, the last admin, a read-only account trying to
 * change something, a session that has expired.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashPassword, openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { MIN_PASSWORD_LENGTH, NO_PASSWORD, UserStore, normalizeUsername } from "@/modules/users/users.store.ts";
import { ensureInitialAdmin, firstRunBanner, seedSharedInitialAdmin } from "@/modules/users/bootstrap.ts";
import { atLeast, identify, readCookie, sessionCookie, type Principal } from "@/modules/users/auth.ts";
import { cheapPasswords } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let users: UserStore;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-users-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
  users = new UserStore({ passwords: cheapPasswords, db });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const GOOD = "correct horse battery";

describe("UserStore", () => {
  test("creates an account and never returns its hash", async () => {
    const user = await users.create({
      username: "Gading",
      password: GOOD,
      role: "admin",
      createdBy: "test",
    });

    expect(user.username).toBe("gading");
    expect(user.role).toBe("admin");
    expect(JSON.stringify(user)).not.toContain("argon2");
    expect(users.count()).toBe(1);
  });

  test("usernames differing only in case are the same account", async () => {
    // The unique index cannot see the difference either, so without normalising this fails as a
    // constraint error at some later date instead of a clear message now.
    await users.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    expect(
      users.create({ username: "GADING", password: GOOD, role: "viewer", createdBy: "t" }),
    ).rejects.toThrow("already exists");
    expect(normalizeUsername("  GaDiNg ")).toBe("gading");
  });

  test("a changed password is held to the same floor as a new one, and the floor itself is allowed", async () => {
    // The create path is checked by "a password that is given is still held to the minimum" below; a change
    // is the other way a password is chosen, and nothing caught the floor going missing there.
    const user = await users.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    await expect(users.setPassword(user.id, "x".repeat(MIN_PASSWORD_LENGTH - 1), "t")).rejects.toThrow(
      String(MIN_PASSWORD_LENGTH),
    );
    expect(await users.verify("gading", GOOD)).not.toBeNull();

    const exact = "y".repeat(MIN_PASSWORD_LENGTH);
    await users.setPassword(user.id, exact, "t");
    expect(await users.verify("gading", exact)).not.toBeNull();
    await users.create({ username: "exact", password: exact, role: "viewer", createdBy: "t" });
  });

  test("verify accepts the right password and rejects everything else", async () => {
    await users.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });

    expect(await users.verify("gading", GOOD)).not.toBeNull();
    expect(await users.verify("gading", "wrong password")).toBeNull();
    // Unknown username must be indistinguishable from a wrong password to the caller.
    expect(await users.verify("nobody", GOOD)).toBeNull();
  });

  test("hashes and checks every password through its hasher — the runtime's argon2id unless a test passes one", async () => {
    // Every path: a create, a right and a wrong password, an unknown name (the dummy hash it is checked against), and a
    // change. One that reached past the option for the runtime's function would cost the real 75 ms in every test again.
    const calls: string[] = [];
    const store = new UserStore({
      db,
      passwords: {
        hash: async (password) => (calls.push(`hash`), cheapPasswords.hash(password)),
        verify: async (password, hash) => (calls.push(`verify`), cheapPasswords.verify(password, hash)),
        needsRehash: (hash) => cheapPasswords.needsRehash(hash),
      },
    });
    const user = await store.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    expect(await store.verify("gading", GOOD)).not.toBeNull();
    expect(await store.verify("gading", "wrong password")).toBeNull();
    expect(await store.verify("nobody", GOOD)).toBeNull();
    await store.setPassword(user.id, "another good one", "t");
    expect(calls).toEqual(["hash", "verify", "verify", "hash", "verify", "hash"]);

    // And with none given, the daemon's: OWASP's argon2id cost, 19 MiB.
    await new UserStore({ db }).create({ username: "real", password: GOOD, role: "viewer", createdBy: "t" });
    const stored = db.prepare<{ password_hash: string }>("SELECT password_hash FROM users WHERE username = 'real'").get();
    expect(stored?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  test("a password hashed at the old 64 MiB cost signs in, and is hashed again at today's — a wrong one changes nothing", async () => {
    // Every account made before 0.7.11: Bun's default cost, which the stored hash carries. The daemon's own hasher here,
    // since what it re-hashes to is the point.
    const store = new UserStore({ db });
    const user = await store.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    const old = await hashPassword(GOOD, { memoryCost: 65536, timeCost: 2 });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(old, user.id);
    const hashOf = () => db.prepare<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?").get(user.id)?.password_hash;
    const session = store.startSession(user.id);

    expect(await store.verify("gading", "wrong password")).toBeNull();
    expect(hashOf()).toBe(old);

    expect(await store.verify("gading", GOOD)).not.toBeNull();
    expect(hashOf()).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    // Not a password change: the account's other sessions stay, and so does what it was last changed at.
    expect(store.sessionUser(session.token)?.id).toBe(user.id);
    expect(store.byId(user.id)?.updatedAt).toBe(user.updatedAt);

    // The new hash is the same password, and it is current: the next sign-in leaves it as it is.
    const rehashed = hashOf();
    expect(await store.verify("gading", GOOD)).not.toBeNull();
    expect(hashOf()).toBe(rehashed);
    expect(await store.verify("gading", "wrong password")).toBeNull();
    // Eight hashes at the real costs, two of them 64 MiB: about half a second alone, past five on a machine running
    // several suites at once — which is where it was found timing out.
  }, 30_000);

  test("verify records the login time", async () => {
    let clock = 1000;
    const store = new UserStore({ passwords: cheapPasswords, db, now: () => clock });
    await store.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    expect(store.byUsername("gading")?.lastLoginAt).toBeNull();

    clock = 5000;
    const user = await store.verify("gading", GOOD);
    expect(user?.lastLoginAt).toBe(5000);
  });

  test("a changed password clears must_change_password", async () => {
    const user = await users.create({
      username: "gading",
      password: GOOD,
      role: "admin",
      createdBy: "t",
      mustChangePassword: true,
    });
    expect(user.mustChangePassword).toBe(true);

    await users.setPassword(user.id, "a different one", "gading");
    expect(users.byId(user.id)?.mustChangePassword).toBe(false);
    expect(await users.verify("gading", "a different one")).not.toBeNull();
    expect(await users.verify("gading", GOOD)).toBeNull();
  });

  test("the last admin cannot be deleted", async () => {
    // Otherwise the instance reaches a state with no way to create one from the dashboard, and the only
    // remedy is editing SQLite by hand — the exact terminal step this surface exists to remove.
    const admin = await users.create({
      username: "gading",
      password: GOOD,
      role: "admin",
      createdBy: "t",
    });
    await users.create({ username: "helper", password: GOOD, role: "operator", createdBy: "t" });

    expect(users.delete(admin.id, "t")).toMatchObject({ ok: false });

    const second = await users.create({
      username: "other",
      password: GOOD,
      role: "admin",
      createdBy: "t",
    });
    expect(users.delete(admin.id, "t")).toEqual({ ok: true });
    expect(users.delete(second.id, "t")).toMatchObject({ ok: false, why: "last-admin" });
  });

  test("nobody deletes their own account, however many admins there are", async () => {
    /**
     * The only guard used to be `adminCount() <= 1`, which catches this by accident and only when it
     * happens to be true. With two admins an admin could delete themselves and be signed out of a
     * daemon they still administer — the row gone, and no way back in from that browser.
     *
     * Two different rules that overlapped: the last-admin one is about the daemon keeping an
     * administrator, this one is about a person not removing their own way in.
     */
    const first = await users.create({ username: "a", password: GOOD, role: "admin", createdBy: "t" });
    const second = await users.create({ username: "b", password: GOOD, role: "admin", createdBy: "t" });

    const own = users.delete(first.id, "a", first.id);
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own).toMatchObject({ reason: expect.stringContaining("your own account"), why: "own" });
    // Still there, and still able to delete somebody else.
    expect(users.byId(first.id)).toBeTruthy();
    expect(users.delete(second.id, "a", first.id)).toEqual({ ok: true });
  });

  test("the control token has no account to protect, so it is not blocked", async () => {
    /**
     * `principal.user` is absent for the CLI, which runs on the operator's own machine. Refusing it
     * would leave a daemon whose only admin account is unreachable — forgotten password, lost device
     * — with no way to clear the row and start again.
     */
    const only = await users.create({ username: "solo", password: GOOD, role: "admin", createdBy: "t" });
    await users.create({ username: "spare", password: GOOD, role: "admin", createdBy: "t" });
    expect(users.delete(only.id, "cli")).toEqual({ ok: true });
  });
});

describe("sessions", () => {
  test("a token identifies its account until it is ended", async () => {
    const user = await users.create({
      username: "gading",
      password: GOOD,
      role: "admin",
      createdBy: "t",
    });

    const { token } = users.startSession(user.id);
    expect(users.sessionUser(token)?.id).toBe(user.id);

    users.endSession(token);
    expect(users.sessionUser(token)).toBeNull();
  });

  test("an expired session is rejected and cleaned up as it is found", async () => {
    let clock = 1000;
    const store = new UserStore({ passwords: cheapPasswords, db, now: () => clock });
    const user = await store.create({
      username: "gading",
      password: GOOD,
      role: "admin",
      createdBy: "t",
    });
    const { token, expiresAt } = store.startSession(user.id);

    clock = expiresAt + 1;
    expect(store.sessionUser(token)).toBeNull();
    // Deleted on the way past, so the row does not sit there until something else sweeps it.
    expect(store.sweepExpiredSessions()).toBe(0);
  });

  test("a session nobody presents again is swept at the next sign-in", async () => {
    // A browser closed for good never brings its token back, so the lookup above never deletes its row.
    let clock = 1000;
    const store = new UserStore({ passwords: cheapPasswords, db, now: () => clock });
    const user = await store.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    const { expiresAt } = store.startSession(user.id);
    const rows = () => db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM user_sessions").get()?.n ?? 0;
    expect(rows()).toBe(1);

    clock = expiresAt + 1;
    store.startSession(user.id);

    expect(rows()).toBe(1);
  });

  test("changing a password drops every other session", async () => {
    // The usual reason to change a password is believing somebody else has it. Leaving their session
    // alive answers the wrong half of that.
    const user = await users.create({
      username: "gading",
      password: GOOD,
      role: "admin",
      createdBy: "t",
    });
    const stolen = users.startSession(user.id);
    const mine = users.startSession(user.id);

    users.endAllSessions(user.id);
    expect(users.sessionUser(stolen.token)).toBeNull();
    expect(users.sessionUser(mine.token)).toBeNull();
  });

  test("an unknown token is nobody", () => {
    expect(users.sessionUser("not-a-real-token")).toBeNull();
    expect(users.sessionUser("")).toBeNull();
  });

  test("only the SHA-256 of a token is kept, and what the table holds signs nobody in (0.8.17)", async () => {
    // The database goes into every snapshot, a USB drive's included: a row read off a copy must not be a cookie.
    const user = await users.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    const { token } = users.startSession(user.id);
    const rows = db.prepare<Record<string, unknown>>("SELECT * FROM user_sessions").all();
    expect(rows.map((row) => row.token_hash)).toEqual([createHash("sha256").update(token).digest("hex")]);
    expect(JSON.stringify(rows)).not.toContain(token);

    expect(users.sessionUser(String(rows[0]!.token_hash))).toBeNull();
    expect(users.sessionUser(token)?.id).toBe(user.id);
    users.endSession(token);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM user_sessions").get()).toEqual({ n: 0 });
  });
});

describe("the sessions a database of 0.8.16 holds", () => {
  test("are cleared by the upgrade, so everyone signs in once; the accounts stay, and a new session is kept hashed", async () => {
    const old = openDatabase(":memory:");
    await migrate(old, {}, MIGRATIONS.filter((one) => one.version <= 74));
    const store = new UserStore({ passwords: cheapPasswords, db: old });
    const user = await store.create({ username: "gading", password: GOOD, role: "admin", createdBy: "t" });
    // As 0.8.16 wrote it: the token itself, the cookie's value.
    old.prepare("INSERT INTO user_sessions (id, user_id, token, expires_at, created_at) VALUES ('uss_old', ?, 'token-of-0816', ?, 1)")
      .run(user.id, Date.now() + 86_400_000);

    await migrate(old);
    // This build's schema, whatever came after 075: the test is of what 075 did on the way.
    expect(old.userVersion()).toBe(MIGRATIONS.at(-1)!.version);
    expect(old.prepare("SELECT * FROM user_sessions").all()).toEqual([]);
    expect(store.sessionUser("token-of-0816")).toBeNull();
    expect(await store.verify("gading", GOOD)).toMatchObject({ id: user.id, role: "admin" });

    const { token } = store.startSession(user.id);
    expect(store.sessionUser(token)?.id).toBe(user.id);
    old.close();
  });
});

describe("bootstrap", () => {
  test("uses INITIAL_ADMIN_* when both are set", async () => {
    const result = await ensureInitialAdmin(users, {
      INITIAL_ADMIN_USERNAME: "gading",
      INITIAL_ADMIN_PASSWORD: GOOD,
    });

    expect(result).toMatchObject({ created: true, username: "gading" });
    expect(result.generatedPassword).toBeUndefined();
    // A password the operator chose is theirs; nothing forces a change.
    expect(users.byUsername("gading")?.mustChangePassword).toBe(false);
  });

  test("INITIAL_ADMIN_MUST_CHANGE makes an environment password work once", async () => {
    // A Nouride Box: the factory sets the card's setup PIN as the first login, and the owner must
    // replace it — anyone who has seen the card has seen the PIN.
    await ensureInitialAdmin(users, {
      INITIAL_ADMIN_USERNAME: "admin",
      INITIAL_ADMIN_PASSWORD: "K7M2QX94",
      INITIAL_ADMIN_MUST_CHANGE: "1",
    });
    expect(users.byUsername("admin")?.mustChangePassword).toBe(true);
    expect(await users.verify("admin", "K7M2QX94")).not.toBeNull();
  });

  test("generates a password when the environment says nothing", async () => {
    const result = await ensureInitialAdmin(users, {});

    expect(result.created).toBe(true);
    expect(result.username).toBe("admin");
    expect(result.generatedPassword).toBeTruthy();
    // A credential the operator did not choose works once and then must be replaced.
    expect(users.byUsername("admin")?.mustChangePassword).toBe(true);
    expect(await users.verify("admin", result.generatedPassword as string)).not.toBeNull();
  });

  test("half a configuration is ignored rather than half-applied", async () => {
    // A username with no password would otherwise produce a generated password under a name the
    // operator chose, which reads in the log as though their setting was honoured.
    const result = await ensureInitialAdmin(users, { INITIAL_ADMIN_USERNAME: "gading" });
    expect(result.generatedPassword).toBeTruthy();
  });

  test("a rejected INITIAL_ADMIN_PASSWORD still leaves a usable account", async () => {
    // Refusing to boot over a too-short password would lock the operator out of the fix.
    const result = await ensureInitialAdmin(users, {
      INITIAL_ADMIN_USERNAME: "gading",
      INITIAL_ADMIN_PASSWORD: "abc",
    });

    expect(result.created).toBe(true);
    expect(result.generatedPassword).toBeTruthy();
    expect(users.byUsername("gading")).not.toBeNull();
  });

  test("does nothing once an account exists", async () => {
    await ensureInitialAdmin(users, {});
    const second = await ensureInitialAdmin(users, {});

    expect(second.created).toBe(false);
    expect(users.count()).toBe(1);
  });

  test("the banner carries the credential and where to use it", () => {
    const banner = firstRunBanner({
      username: "admin",
      password: "hunter2hunter2hunter2",
      url: "http://localhost:18254/dashboard/",
    });

    expect(banner).toContain("admin");
    expect(banner).toContain("hunter2hunter2hunter2");
    expect(banner).toContain("http://localhost:18254/dashboard/");
    expect(banner).toContain("INITIAL_ADMIN_USERNAME");
  });

  test("the banner names the gateway only when the gateway shares the credential", () => {
    const shared = firstRunBanner({
      username: "admin",
      password: "hunter2hunter2hunter2",
      url: "http://localhost:18254/dashboard/",
      gatewayUrl: "http://127.0.0.1:3000",
    });
    expect(shared).toContain("http://127.0.0.1:3000/frontend/");

    const alone = firstRunBanner({
      username: "admin",
      password: "hunter2hunter2hunter2",
      url: "http://localhost:18254/dashboard/",
    });
    expect(alone).not.toContain("gateway");
  });
});

/**
 * The bundled gateway bootstraps its own admin account from the same two variables this one reads,
 * so on a first run a `router` build would otherwise print two banners with two different passwords.
 */
describe("lending the first run to the bundled gateway", () => {
  /** The generated branch, narrowed — the `environment` branch carries no password to assert on. */
  function lend(env: Record<string, string | undefined>, firstRun = true) {
    const shared = seedSharedInitialAdmin({ firstRun, env });
    return shared?.mode === "generated" ? shared : null;
  }

  test("puts a generated credential where the gateway will read it, then takes it back", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };

    const lent = lend(env);
    expect(lent).not.toBeNull();
    // Set for the gateway's boot and nothing longer.
    expect(env.INITIAL_ADMIN_USERNAME).toBe("admin");
    expect(env.INITIAL_ADMIN_PASSWORD).toBe(lent?.password);
    // And marked as a password nobody chose, so the gateway forces its change too. Without it the
    // gateway read the lent password as the operator's and kept it for good.
    expect(env.INITIAL_ADMIN_MUST_CHANGE).toBe("1");

    lent?.clear();
    expect("INITIAL_ADMIN_USERNAME" in env).toBe(false);
    expect("INITIAL_ADMIN_PASSWORD" in env).toBe(false);
    expect("INITIAL_ADMIN_MUST_CHANGE" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("the dashboard account gets that same password, and still has to change it", async () => {
    const env: Record<string, string | undefined> = {};
    const lent = lend(env);
    lent?.clear();

    const result = await ensureInitialAdmin(users, {}, lent?.password);

    expect(result.generatedPassword).toBe(lent?.password as string);
    expect(await users.verify("admin", lent?.password as string)).not.toBeNull();
    // The whole reason the password is handed in rather than read back out of the environment: an
    // env-set password is the operator's choice and exempt from this, a generated one is not.
    expect(users.byUsername("admin")?.mustChangePassword).toBe(true);
  });

  /**
   * The case a screenshot found on 2026-09-16.
   *
   * Nothing to arrange — both products read the same two names — but "nothing to arrange" is not
   * "nothing to say": the wizard still has to tell the operator which password opens the gateway,
   * and reporting only the lending left the commonest setup of all describing itself as unshared.
   */
  test("reports the operator's own pair as shared, without touching it", () => {
    const env = { INITIAL_ADMIN_USERNAME: "gading", INITIAL_ADMIN_PASSWORD: GOOD };
    expect(seedSharedInitialAdmin({ firstRun: true, env })).toEqual({ mode: "environment" });
    expect(env.INITIAL_ADMIN_PASSWORD).toBe(GOOD);
  });

  test("and reports it on a daemon long past its own first run", () => {
    // The gateway keeps its users elsewhere, so it can be bootstrapping while this daemon is not —
    // which is why this answer is not gated on `firstRun` the way the generated one is.
    const env = { INITIAL_ADMIN_USERNAME: "gading", INITIAL_ADMIN_PASSWORD: GOOD };
    expect(seedSharedInitialAdmin({ firstRun: false, env })).toEqual({ mode: "environment" });
  });

  test("keeps a username the operator set on its own, and puts it back afterwards", () => {
    const env: Record<string, string | undefined> = { INITIAL_ADMIN_USERNAME: "gading" };
    const lent = lend(env);

    expect(lent?.username).toBe("gading");
    expect(env.INITIAL_ADMIN_PASSWORD).toBe(lent?.password);

    lent?.clear();
    // Restored, not deleted: a half-set pair is a case both bootstraps warn about, and swallowing
    // the operator's half here would silence the warning that explains it.
    expect(env.INITIAL_ADMIN_USERNAME).toBe("gading");
    expect("INITIAL_ADMIN_PASSWORD" in env).toBe(false);
  });

  test("lends nothing on a daemon that already has accounts", () => {
    const env: Record<string, string | undefined> = {};
    expect(seedSharedInitialAdmin({ firstRun: false, env })).toBeNull();
    expect(env.INITIAL_ADMIN_PASSWORD).toBeUndefined();
  });
});

describe("authorisation", () => {
  const principal = (role: Principal["role"]): Principal => ({ kind: "user", actor: "x", role });

  test("roles are ranked, not enumerated", () => {
    expect(atLeast(principal("admin"), "operator")).toBe(true);
    expect(atLeast(principal("operator"), "operator")).toBe(true);
    expect(atLeast(principal("viewer"), "operator")).toBe(false);
    expect(atLeast(principal("operator"), "admin")).toBe(false);
    expect(atLeast(principal("viewer"), "viewer")).toBe(true);
  });

  test("the control token is the host's own credential, so it is an admin", () => {
    expect(atLeast({ kind: "token", actor: "cli", role: "admin" }, "admin")).toBe(true);
  });
});

describe("cookies", () => {
  test("reads one cookie without matching a longer name", () => {
    const header = "other=1; nouride_session=abc123; nouride_session_x=nope";
    expect(readCookie(header, "nouride_session")).toBe("abc123");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(undefined, "nouride_session")).toBeUndefined();
  });

  test("the session cookie is httpOnly, and Secure only over TLS", () => {
    const plain = sessionCookie("abc", Date.now() + 60_000, false);
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    // A plain-HTTP install is what `docker compose up` on a laptop produces; an unconditional Secure
    // flag would make it impossible to log in there.
    expect(plain).not.toContain("Secure");

    expect(sessionCookie("abc", Date.now() + 60_000, true)).toContain("Secure");
  });
});

describe("the control token", () => {
  const TOKEN = "a".repeat(64);

  test("the right token identifies the CLI as admin", () => {
    expect(identify({ tokenHeader: TOKEN, cookieHeader: undefined, controlToken: TOKEN })).toEqual({
      kind: "token",
      actor: "cli",
      role: "admin",
    });
  });

  test("a wrong token of the same length is rejected", () => {
    const wrong = "a".repeat(63) + "b";
    expect(identify({ tokenHeader: wrong, cookieHeader: undefined, controlToken: TOKEN })).toBeNull();
  });

  test("a missing or empty header is rejected without comparing", () => {
    expect(identify({ tokenHeader: undefined, cookieHeader: undefined, controlToken: TOKEN })).toBeNull();
    expect(identify({ tokenHeader: "", cookieHeader: undefined, controlToken: TOKEN })).toBeNull();
  });

  test("a multibyte header of the same string length is rejected, not thrown", () => {
    // `timingSafeEqual` throws on a length mismatch, and the guard used to compare *string* lengths:
    // 64 characters of `é` is 128 bytes, so this reached the comparison and took the request down with
    // a RangeError instead of answering 401.
    const multibyte = "é".repeat(64);
    expect(multibyte.length).toBe(TOKEN.length);
    expect(() =>
      identify({ tokenHeader: multibyte, cookieHeader: undefined, controlToken: TOKEN }),
    ).not.toThrow();
    expect(identify({ tokenHeader: multibyte, cookieHeader: undefined, controlToken: TOKEN })).toBeNull();
  });
});

/**
 * Accounts with no password, and an install that accepts none.
 *
 * Both exist for the same reason: on an install that signs people in through an
 * identity provider, a password is a second way in that nobody uses and
 * everybody has to keep secret. Adding somebody by email IS the act that grants
 * them access, because the provider's identity is matched to an account that
 * already exists and never creates one.
 *
 * What is tested is the part that fails silently. A sentinel that a hash
 * function could produce, or a `verify` that treats an unparseable hash as a
 * match, is an open door that every normal login passes straight over.
 */
describe("an account with no password", () => {
  test("can be created, and reports that it has none", async () => {
    const user = await users.create({ username: "jordan@example.test", role: "operator", createdBy: "test" });
    expect(user.hasPassword).toBe(false);
    // Meaningless without a password, and worse: it would send the account to a
    // change-password screen it can never satisfy.
    expect(user.mustChangePassword).toBe(false);
  });

  test("cannot be signed into with any password, including the sentinel itself", async () => {
    await users.create({ username: "jordan@example.test", role: "operator", createdBy: "test" });

    for (const attempt of ["", " ", "!", "password", "jordan@example.test", NO_PASSWORD]) {
      expect(await users.verify("jordan@example.test", attempt), JSON.stringify(attempt)).toBeNull();
    }
  });

  test("the sentinel is not something a hash could produce", () => {
    // An empty string would be: a bug that skipped hashing would write one, and
    // a `verify` that then matched empty-to-empty is an open door. `!` cannot be
    // the output of argon2 or bcrypt, so it can never be mistaken for a hash.
    expect(NO_PASSWORD).toBe("!");
    expect(NO_PASSWORD).not.toBe("");
  });

  test("is reversible — a password can be set later", async () => {
    const user = await users.create({ username: "jordan@example.test", role: "operator", createdBy: "test" });
    expect(user.hasPassword).toBe(false);

    await users.setPassword(user.id, "a-real-password-1", "test");
    expect(users.byId(user.id)?.hasPassword).toBe(true);
    expect(await users.verify("jordan@example.test", "a-real-password-1")).not.toBeNull();
  });

  test("a password that is given is still held to the minimum", async () => {
    await expect(
      users.create({ username: "jordan@example.test", password: "short", role: "operator", createdBy: "test" }),
    ).rejects.toThrow(/at least/);
  });
});

describe("the first-login banner on a box bound to every interface", () => {
  test("names the addresses another device can open, under the local one", async () => {
    const { firstRunBanner } = await import("@/modules/users/bootstrap.ts");
    const text = firstRunBanner({ username: "admin", password: "p", url: "http://localhost:18254/dashboard/", alsoAt: ["http://192.168.0.54:18254/dashboard/"] });
    expect(text).toContain("or from another device on this network:\n    http://192.168.0.54:18254/dashboard/");
    expect(firstRunBanner({ username: "admin", password: "p", url: "http://localhost:18254/dashboard/" })).not.toContain("another device");
  });
});
