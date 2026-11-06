/**
 * What an agent's commands read is moved out of `data/` once, with the rows that name it (`boot/kept-folders.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { keptFolders, settleKeptFolders } from "@/boot/kept-folders.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { tempDir } from "../helpers.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(): { config: typeof DEFAULT_CONFIG; db: SqliteDb; nouride: string } {
  const nouride = tempDir("nouride-kept-");
  made.push(nouride);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(nouride, "data");
  config.security.credentialsDir = "";
  mkdirSync(config.daemon.dataDir, { recursive: true });
  const db = openDatabase(join(config.daemon.dataDir, "nouride.db"));
  migrate(db);
  return { config, db, nouride };
}

function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("each folder moves beside data/, and every row that named a file in it names it there", () => {
  const { config, db, nouride } = install();
  const data = config.daemon.dataDir;
  put(join(data, "jobs/nouva/job_1.log"), "started\n");
  put(join(data, "attachments/nouva/abc/photo.jpg"), "jpeg");
  put(join(data, "tool-output/nouva/s1/call.txt"), "long");
  put(join(data, "credentials/id_ed25519"), "key");
  db.prepare(
    `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at) VALUES ('j1', 'nouva', 'tg', 'c', 'make', '/w', 'succeeded', ?, 1)`,
  ).run(join(data, "jobs/nouva/job_1.log"));
  db.prepare(`INSERT INTO chat_attachments (ref, gateway, chat_id, gateway_id, name, mime_type, kind, local_path, at) VALUES ('r1', 'telegram', 'c', 'tg', 'photo.jpg', 'image/jpeg', 'image', ?, 1)`).run(
    join(data, "attachments/nouva/abc/photo.jpg"),
  );
  const message = JSON.stringify({ role: "user", content: [{ type: "image_ref", localPath: join(data, "attachments/nouva/abc/photo.jpg") }, { type: "text", text: `Full output: ${join(data, "tool-output/nouva/s1/call.txt")}` }] });
  db.prepare(`INSERT INTO sessions (id, agent_id, gateway, chat_id, created_at, updated_at) VALUES ('s1', 'nouva', 'tg', 'c', 1, 1)`).run();
  db.prepare(`INSERT INTO session_messages (session_id, seq, hash, message) VALUES ('s1', 0, 'h', ?)`).run(message);

  const settled = settleKeptFolders(config, db);

  expect(settled).toEqual(keptFolders(config));
  expect(settled.jobs).toBe(join(nouride, "jobs"));
  expect(readFileSync(join(nouride, "attachments/nouva/abc/photo.jpg"), "utf-8")).toBe("jpeg");
  expect(readFileSync(join(nouride, "credentials/id_ed25519"), "utf-8")).toBe("key");
  for (const name of ["jobs", "attachments", "tool-output", "credentials"]) expect(existsSync(join(data, name))).toBe(false);
  expect(db.prepare<{ log_path: string }>("SELECT log_path FROM jobs").get()!.log_path).toBe(join(nouride, "jobs/nouva/job_1.log"));
  expect(db.prepare<{ local_path: string }>("SELECT local_path FROM chat_attachments").get()!.local_path).toBe(join(nouride, "attachments/nouva/abc/photo.jpg"));
  const row = db.prepare<{ message: string; hash: string | null }>("SELECT message, hash FROM session_messages").get()!;
  expect(row.message).toBe(message.replaceAll(`${data}/`, `${nouride}/`));
  // Its hash was of the old text: cleared, so the store writes the row once more with its own.
  expect(row.hash).toBeNull();
});

test("a second start moves nothing, and a credentials directory the operator named is theirs", () => {
  const { config, db, nouride } = install();
  config.security.credentialsDir = join(nouride, "agents/shared/.credentials");
  put(join(config.daemon.dataDir, "credentials/stale"), "x");
  settleKeptFolders(config, db);
  expect(existsSync(join(config.daemon.dataDir, "credentials/stale"))).toBe(true);
  expect(keptFolders(config).credentials).toBe(config.security.credentialsDir);
  expect(settleKeptFolders(config, db)).toEqual(keptFolders(config));
});

test("a folder already beside data/ takes in what was inside, keeping what it had", () => {
  const { config, db, nouride } = install();
  put(join(nouride, "jobs/nouva/new.log"), "new");
  put(join(config.daemon.dataDir, "jobs/nouva/new.log"), "old copy");
  put(join(config.daemon.dataDir, "jobs/nox/old.log"), "old");
  settleKeptFolders(config, db);
  expect(readFileSync(join(nouride, "jobs/nouva/new.log"), "utf-8")).toBe("new");
  expect(readFileSync(join(nouride, "jobs/nox/old.log"), "utf-8")).toBe("old");
});

test("rows a move left behind — stopped between the folder and the rows — are renamed on the next start", () => {
  const { config, db, nouride } = install();
  mkdirSync(join(nouride, "attachments"), { recursive: true });
  db.prepare(`INSERT INTO chat_attachments (ref, gateway, chat_id, gateway_id, name, mime_type, kind, local_path, at) VALUES ('r1', 'telegram', 'c', 'tg', 'a.jpg', 'image/jpeg', 'image', ?, 1)`).run(
    join(config.daemon.dataDir, "attachments/nouva/a.jpg"),
  );
  settleKeptFolders(config, db);
  expect(db.prepare<{ local_path: string }>("SELECT local_path FROM chat_attachments").get()!.local_path).toBe(join(nouride, "attachments/nouva/a.jpg"));
});
