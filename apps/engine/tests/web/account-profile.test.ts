/**
 * A person's name and handle. (The forced first password change, which does not ask for the old password,
 * is pinned in `users.test.ts`: "a changed password clears must_change_password".)
 *
 * Both of these came from the same bug. Setup asked "what should the agent call you", wrote the answer
 * into a file every agent read on every turn, and greeted the second person to message the bot by the
 * first person's name. The fix has two halves: a name belongs to an *account* rather than to the
 * installation, and it starts empty — because "nobody has said" is a real state, and the honest
 * behaviour then is to use no name at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { cheapPasswords } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let users: UserStore;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-profile-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
  users = new UserStore({ passwords: cheapPasswords, db });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = "correct horse battery";

async function admin(username = "gading") {
  return users.create({ username, password: PASSWORD, role: "admin", createdBy: "test" });
}

describe("display name", () => {
  test("a new account has no name, and that is not the username", async () => {
    const user = await admin();
    expect(user.displayName).toBe("");
    // The distinction the whole fix rests on: nothing anywhere may fall back to the login handle.
    expect(user.displayName).not.toBe(user.username);
  });

  test("is stored, trimmed, and can be cleared back to empty", async () => {
    const user = await admin();

    users.setDisplayName(user.id, "  Gading  ", "test");
    expect(users.byId(user.id)?.displayName).toBe("Gading");

    users.setDisplayName(user.id, "", "test");
    expect(users.byId(user.id)?.displayName).toBe("");
  });

  test("two accounts may share a name — it is not an identifier", async () => {
    const one = await admin("gading");
    const two = await users.create({
      username: "wife",
      password: PASSWORD,
      role: "operator",
      createdBy: "test",
    });

    users.setDisplayName(one.id, "Sutan", "test");
    users.setDisplayName(two.id, "Sutan", "test");

    expect(users.byId(one.id)?.displayName).toBe("Sutan");
    expect(users.byId(two.id)?.displayName).toBe("Sutan");
    expect(users.byId(one.id)?.username).not.toBe(users.byId(two.id)?.username);
  });
});

describe("username changes", () => {
  test("renames, lowercased, and the old handle stops resolving", async () => {
    const user = await admin("gading");

    expect(users.setUsername(user.id, "Nouva", "test")).toEqual({ ok: true });
    expect(users.byId(user.id)?.username).toBe("nouva");
    expect(users.byUsername("gading")).toBeNull();
    expect(users.byUsername("nouva")?.id).toBe(user.id);
  });

  test("refuses a handle someone else holds, rather than reporting success", async () => {
    const one = await admin("gading");
    await users.create({ username: "wife", password: PASSWORD, role: "operator", createdBy: "t" });

    const result = users.setUsername(one.id, "wife", "test");
    expect(result.ok).toBe(false);
    // The point of the refusal: without it the caller signs in with a name that was never applied.
    expect(users.byId(one.id)?.username).toBe("gading");
  });

  test("renaming to your own handle is a no-op, not a conflict", async () => {
    const user = await admin("gading");
    expect(users.setUsername(user.id, "GADING", "test")).toEqual({ ok: true });
    expect(users.byId(user.id)?.username).toBe("gading");
  });

  test("accepts a plus-tagged email", async () => {
    const user = await admin("gading");
    expect(users.setUsername(user.id, "gading+bot@nouverse.com", "test")).toEqual({ ok: true });
    expect(users.byId(user.id)?.username).toBe("gading+bot@nouverse.com");
  });

  test("refuses a handle that is empty or shaped wrong", async () => {
    const user = await admin();
    expect(users.setUsername(user.id, "   ", "test").ok).toBe(false);
    expect(users.setUsername(user.id, "has space", "test").ok).toBe(false);
    expect(users.setUsername(user.id, "quote\"d", "test").ok).toBe(false);
  });
});
