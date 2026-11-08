/**
 * `nouride users reset` — a lost first password, recovered with the binary a box has.
 *
 * The documented recovery was `sqlite3 … 'DELETE FROM user_sessions; DELETE FROM users'`, and neither a Box nor the
 * boxes this is deployed to have `sqlite3`. The CLI is spawned as an operator runs it, against an install of its own:
 * refused while a daemon holds the database, and otherwise every account and sign-in gone, the database snapshotted
 * first, what went said — and the table left the way boot reads as a first run, so the next start makes an admin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { ensureInitialAdmin } from "@/modules/users/bootstrap.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { runCli } from "../cli-harness.ts";
import { cheapPasswords } from "../helpers.ts";

let root: string;
let data: string;
let configPath: string;
let ids: { admin: string; sam: string };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nouride-users-reset-"));
  data = join(root, "data");
  configPath = join(root, "config.toml");
  writeFileSync(configPath, `[daemon]\ndata_dir = "${data}"\n`);
  const db = await openAndMigrate(join(data, "nouride.db"));
  const store = new UserStore({ db, passwords: cheapPasswords });
  const admin = await store.create({ username: "admin", password: "first-password", role: "admin", createdBy: "bootstrap", mustChangePassword: true });
  const sam = await store.create({ username: "sam", password: "sams-password", role: "operator", createdBy: "admin" });
  store.startSession(admin.id);
  store.startSession(sam.id);
  ids = { admin: admin.id, sam: sam.id };
  db.close();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return await runCli(args, { cwd: root, config: configPath });
}

/** A count from a database file, opened for the one query and closed. */
function count(path: string, table: string, where = ""): number {
  const db: SqliteDb = openDatabase(path);
  try {
    return db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get()?.n ?? -1;
  } finally {
    db.close();
  }
}

describe("nouride users reset", () => {
  test("is refused while a daemon holds the database, and nothing is removed", async () => {
    // A live process that calls itself a Nouride, holding the lock — as `db restore` and `update --rollback` are tested.
    const holder: ChildProcess = spawn("sh", ["-c", "sleep 30; :", "nouride-lock-holder"]);
    try {
      writeFileSync(join(data, "nouride.lock"), `${holder.pid}\n`);
      const refused = await cli("users", "reset");
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("The daemon is running");
    } finally {
      holder.kill();
    }
    expect(count(join(data, "nouride.db"), "users")).toBe(2);
  });

  test("removes every account and every sign-in, snapshots the database first, and says what it removed", async () => {
    const done = await cli("users", "reset");
    expect(done.code).toBe(0);
    expect(done.out).toContain("removed 2 dashboard account(s), and every sign-in");
    // Each one with its id: a People entry that named it as web:<id> has to be changed by hand.
    expect(done.out).toContain(`admin admin · web:${ids.admin}`);
    expect(done.out).toContain(`sam operator · web:${ids.sam}`);
    expect(done.out).toContain("journalctl -u nouride | grep -A12 'Nouride is ready'");

    const live = join(data, "nouride.db");
    expect(count(live, "users")).toBe(0);
    expect(count(live, "user_sessions")).toBe(0);
    expect(count(live, "audit_log", "WHERE action = 'users_reset' AND actor = 'cli'")).toBe(1);

    // The way back: the snapshot named holds them all, and is where `nouride db list` looks.
    const snapshot = /the database as it was is (\S+) \(/.exec(done.out)?.[1] ?? "";
    expect(snapshot.startsWith(join(data, "backups", "db"))).toBe(true);
    expect(count(snapshot, "users")).toBe(2);
  });

  test("leaves the table the way boot reads as a first run: the next start makes an admin and a password", async () => {
    expect((await cli("users", "reset")).code).toBe(0);
    const db = openDatabase(join(data, "nouride.db"));
    try {
      const made = await ensureInitialAdmin(new UserStore({ db, passwords: cheapPasswords }), {});
      expect(made).toMatchObject({ created: true, username: "admin", generatedPassword: expect.any(String) });
    } finally {
      db.close();
    }
  });

  test("--json answers with what went and where the snapshot is", async () => {
    const done = await cli("--json", "users", "reset");
    expect(done.code).toBe(0);
    const { data: answer } = JSON.parse(done.out) as { data: { removed: unknown[]; snapshot: string } };
    expect(answer.removed).toEqual([
      { id: ids.admin, username: "admin", role: "admin" },
      { id: ids.sam, username: "sam", role: "operator" },
    ]);
    expect(existsSync(answer.snapshot)).toBe(true);
  });

  test("with no account there is nothing to do: said, and no snapshot taken", async () => {
    expect((await cli("users", "reset")).code).toBe(0);
    const again = await cli("users", "reset");
    expect(again.code).toBe(0);
    expect(again.out).toContain("There are no accounts to remove");
    expect(count(join(data, "nouride.db"), "audit_log", "WHERE action = 'users_reset'")).toBe(1);
  });

  test("is the recovery the docs give — every page that tells it, and none of them reaches for sqlite3", () => {
    const repo = join(import.meta.dir, "../../../..");
    const pages = [
      "docs/DEPLOY.md",
      "GETTING_STARTED.md",
      "apps/site/src/content/docs/en/docs/start/first-run.mdx",
      "apps/site/src/content/docs/id/docs/start/first-run.mdx",
      "apps/site/src/content/docs/en/docs/reference/faq.md",
      "apps/site/src/content/docs/id/docs/reference/faq.md",
    ];
    for (const page of pages) {
      const whole = readFileSync(join(repo, page), "utf8");
      // DEPLOY.md is long and about everything; its section is what is held here.
      const text = page === "docs/DEPLOY.md" ? (/#### Lost the first password\n([\s\S]*?)\n#/.exec(whole)?.[1] ?? "") : whole;
      expect({ page, names: text.includes("nouride users reset"), sqlite3: /\bsqlite3\b/.test(text) }).toEqual({ page, names: true, sqlite3: false });
    }
  });

  test("an install that never started has nothing to reset — a failure, said; a bare `users` is its help", async () => {
    rmSync(data, { recursive: true, force: true });
    const none = await cli("users", "reset");
    expect(none.code).toBe(1);
    expect(none.err).toContain("No database at");
    const bare = await cli("--json", "users");
    expect(bare.code).toBe(0);
    expect(JSON.parse(bare.out).data.help).toContain("nouride users reset");
    expect((await cli("users", "rest")).code).toBe(2);
  });
});
