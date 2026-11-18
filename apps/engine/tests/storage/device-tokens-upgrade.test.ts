/**
 * Migration 091 (`device_tokens`) on a database as the release before it left it (schema 90): the accounts and their
 * sessions come through as they were, the table is there, and a device token made afterwards is bound to that
 * install's first admin and signs in as it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, sha256Text } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { DeviceTokenStore } from "@/modules/users/devices.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { cheapPasswords, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

describe("upgrading a v0.8.39 database", () => {
  test("keeps its accounts and sessions, and takes device tokens for its first admin", async () => {
    const dir = tempDir("device-upgrade");
    dirs.push(dir);
    const path = join(dir, "nouride.db");

    const old = await openAndMigrate(path, MIGRATIONS.filter((one) => one.version <= 90));
    expect(old.userVersion()).toBe(90);
    const before = new UserStore({ db: old, passwords: cheapPasswords });
    const admin = await before.create({ username: "gading", password: "correct horse battery", role: "admin", createdBy: "test" });
    // The session row as that release wrote it, with the columns it had.
    const session = { token: "a-session-cookie-from-before" };
    old.prepare("INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('uss_old', ?, ?, ?, 1)").run(admin.id, sha256Text(session.token), Date.now() + 86_400_000);
    expect(old.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'device_tokens'").get()!.n).toBe(0);
    old.close();

    const db = await openAndMigrate(path);
    try {
      expect(db.userVersion()).toBe(MIGRATIONS.at(-1)!.version);
      const users = new UserStore({ db, passwords: cheapPasswords });
      expect(users.sessionUser(session.token)?.username).toBe("gading");
      const devices = new DeviceTokenStore(db);
      expect(devices.firstAdmin()).toEqual({ id: admin.id, username: "gading" });
      const made = devices.create({ userId: admin.id, label: "Nouride Home", now: 1 });
      expect(devices.use(made.value, 2)).toMatchObject({ userId: admin.id, username: "gading", lastUsedAt: 2 });
      // A session from before has no device, and revoking one leaves it.
      devices.revoke(made.device.id, 3);
      expect(users.sessionUser(session.token)?.username).toBe("gading");
    } finally {
      db.close();
    }
  });
});
