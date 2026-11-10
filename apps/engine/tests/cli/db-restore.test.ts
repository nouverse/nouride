/**
 * `nouride db restore` and the memory vault, with the CLI spawned as an operator runs it.
 *
 * A restore puts back the database alone; the vault is left as it is. A snapshot from before 0.8.0's schema is one
 * this version does not start on, so it is refused with nothing changed, naming the release that brings it forward.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { startHint } from "@/service/hints.ts";
import { runCli } from "../cli-harness.ts";

let root: string;
let memory: string;
let configPath: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nouride-db-restore-"));
  const data = join(root, "data");
  memory = join(root, "memory");
  mkdirSync(memory, { recursive: true });
  configPath = join(root, "config.toml");
  writeFileSync(configPath, `[daemon]\ndata_dir = "${data}"\n\n[memory]\ndir = "${memory}"\n`);
  (await openAndMigrate(join(data, "nouride.db"))).close();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const EPISODE = "episodes/2026/09/2026-09-25-0900-nouva.md";
const MARKER = ".nouride-vault.json";
const HUB = ["---", "type: day", "---", "", "# 2026-09-25", "", "- [[2026-09-25-0900-nouva]] · nouva · Gading said hello.", ""].join("\n");
const episode = (day: string) =>
  ["---", "id: 2026-09-25-0900-nouva", "type: episode", "status: summarized", "kind: dm", "chat: telegram:nouva:814", "started: 2026-09-25T09:00:00+07:00", `day: "[[${day}]]"`, 'summary: "Gading said hello."', "---", ""].join("\n");

function put(path: string, text: string): void {
  mkdirSync(dirname(join(memory, path)), { recursive: true });
  writeFileSync(join(memory, path), text);
}

function read(path: string): string | null {
  return existsSync(join(memory, path)) ? readFileSync(join(memory, path), "utf8") : null;
}

/** The vault as this build keeps it: the hub by month, the episode linking it there, marked `format`. */
function vaultMarked(format: number): void {
  put(EPISODE, episode("days/2026/09/2026-09-25"));
  put("days/2026/09/2026-09-25.md", HUB);
  put(MARKER, `{"format": ${format}}\n`);
}

/** A snapshot of a database at `schema`, as the build that brought it there left it. */
function snapshot(schema: number): string {
  const path = join(root, `nouride-schema-${schema}.db`);
  const db = openDatabase(path);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
  db.setUserVersion(schema);
  db.close();
  return path;
}

/** The CLI, spawned against this install — and nothing from this shell, which could name a real data directory. */
async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const { code, out, err } = await runCli(args, { cwd: root, config: configPath });
  return { code, out: out + err };
}

test("a snapshot from before the floor is refused, naming it — and the database and the vault are as they were", async () => {
  vaultMarked(2);
  const live = join(root, "data", "nouride.db");
  const before = readFileSync(live);
  // As 0.7.29 left one, or 0.8.0's own snapshot before it migrated: a schema below the one 0.8.0 brought every database to.
  const done = await cli("db", "restore", snapshot(MIGRATIONS[0]!.version - 1));
  expect(done.code).toBe(1);
  expect(done.out).toContain("That snapshot is from before 0.8.0 (schema 68): this version does not start on it. Nothing was changed.");
  expect(done.out).toContain("Restore it with 0.8.0's `nouride db restore` and start 0.8.0 once");
  expect(readFileSync(live)).toEqual(before);
  expect(read("days/2026/09/2026-09-25.md")).toBe(HUB);
  expect(read(EPISODE)).toBe(episode("days/2026/09/2026-09-25"));
  expect(read(MARKER)).toBe('{"format": 2}\n');
}, 30_000);

test("a database of this build's leaves a vault in this build's format as it is", async () => {
  vaultMarked(2);
  const done = await cli("db", "restore", snapshot(MIGRATIONS.at(-1)!.version));
  expect(done.code).toBe(0);
  expect(done.out).not.toContain("memory:");
  expect(read("days/2026/09/2026-09-25.md")).toBe(HUB);
  expect(read(MARKER)).toBe('{"format": 2}\n');
}, 30_000);

test("ends with how this machine starts the daemon — not systemd's on a box that has none", async () => {
  // Found in the 0.7.7 → 0.7.10 upgrade run, inside a container: "start the daemon: systemctl start nouride".
  // Spawned on this machine, so the supervisor `startHint` finds here is the one the restore names.
  const done = await cli("db", "restore", snapshot(MIGRATIONS.at(-1)!.version));
  expect(done.code).toBe(0);
  expect(done.out).toContain(startHint());
  expect(done.out).not.toContain("start the daemon: systemctl start nouride");
}, 30_000);
