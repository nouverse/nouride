/**
 * `nouride gateway rename`, spawned as an operator runs it after `systemctl stop nouride`.
 *
 * What it reaches beside the database is the point here: the config it booted from, every pack bound to the gateway,
 * and the memory vault. Each was once a file the rename left on the old id — a pack then failed to load at the next
 * start, and a group lost its memory — while the command printed that the rename was done.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { openRecorded } from "@/boot/last-run.ts";
import { VERSION } from "@/commons/version.ts";
import { runCli } from "../cli-harness.ts";

let root: string;
let data: string;
let agents: string;
let memory: string;
let configPath: string;

const CONFIG = (dirs: { data: string; agents: string; memory: string }) => `[daemon]
data_dir = "${dirs.data}"
agents_dir = "${dirs.agents}"

[memory]
dir = "${dirs.memory}"

[providers.nougate]
kind = "openai"
base_url = "https://example.invalid/v1"
api_key = "nougate"

[gateways.telegram.bot]
enabled = false
token = "telegram_bot_token"
agent = "nouva"

[security.access]
allowlist = ["telegram:bot:5550001111"]
`;

const PACK = `[llm]
provider = "nougate"
model = "m"

[channels]
"telegram:bot" = ["-1001234"]
`;

const EPISODE = "episodes/2026/09/2026-09-25-0900-nouva.md";
const episode = (chat: string) =>
  ["---", "id: 2026-09-25-0900-nouva", "type: episode", "status: raw", "kind: group", `chat: ${chat}`, 'started: "2026-09-25T09:00:00+07:00"', 'day: "[[days/2026/09/2026-09-25]]"', "---", "", "09:00 · Gading", "Halo.", ""].join("\n");

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nouride-gateway-rename-cli-"));
  data = join(root, "data");
  agents = join(root, "agents");
  memory = join(root, "memory");
  configPath = join(root, "config.toml");
  put(configPath, CONFIG({ data, agents, memory }));
  put(join(agents, "nouva", "IDENTITY.md"), "# Nouva\n");
  put(join(agents, "nouva", "config.toml"), PACK);
  put(join(memory, EPISODE), episode("telegram:bot:-1001234"));
  // As the daemon leaves it: migrated, with the version that did it recorded — which `config check` reads, as the daemon does.
  const db = await openRecorded(data, VERSION);
  db.prepare("INSERT INTO sender_access (gateway_id, sender_id, status, requested_at) VALUES ('telegram:bot', '5550001111', 'approved', 1000)").run();
  db.close();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The CLI, spawned against this install — and nothing from this shell, which could name a real data directory. */
async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const { code, out, err } = await runCli(args, { cwd: root, config: configPath });
  return { code, out: out + err };
}

function gatewayIds(table: string, column: string): string[] {
  const db = openDatabase(join(data, "nouride.db"));
  try {
    return db.prepare<{ id: string }>(`SELECT ${column} AS id FROM ${table}`).all().map((row) => row.id);
  } finally {
    db.close();
  }
}

test("the dry run names the pack's binding and the vault's files, and changes nothing", async () => {
  const done = await cli("gateway", "rename", "telegram:bot", "telegram:nouva");
  expect(done.code).toBe(0);
  expect(done.out).toContain(join(agents, "nouva", "config.toml"));
  expect(done.out).toContain('"telegram:bot" = ["-1001234"]');
  expect(done.out).toMatch(/memory vault[^\n]*\n\s+1\s+episodes/);
  expect(done.out).toContain("Nothing was changed");
  expect(readFileSync(join(agents, "nouva", "config.toml"), "utf8")).toBe(PACK);
  expect(gatewayIds("sender_access", "gateway_id")).toEqual(["telegram:bot"]);
}, 30_000);

test("--apply is refused while the daemon runs, and nothing is renamed", async () => {
  // A live process that calls itself a Nouride, holding the lock — as `users reset` and `db restore` are tested.
  const holder: ChildProcess = spawn("sh", ["-c", "sleep 30; :", "nouride-lock-holder"]);
  try {
    writeFileSync(join(data, "nouride.lock"), `${holder.pid}\n`);
    const refused = await cli("gateway", "rename", "telegram:bot", "telegram:nouva", "--apply");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(`The daemon is running (pid ${holder.pid})`);
  } finally {
    holder.kill();
  }
  expect(gatewayIds("sender_access", "gateway_id")).toEqual(["telegram:bot"]);
  expect(readFileSync(configPath, "utf8")).toContain("[gateways.telegram.bot]");
}, 30_000);

test("--apply moves the database, the config, the pack and the vault — and the config with its packs then loads", async () => {
  const done = await cli("gateway", "rename", "telegram:bot", "telegram:nouva", "--apply");
  expect(done.code).toBe(0);
  expect(done.out).toContain("telegram:bot is now telegram:nouva");

  expect(gatewayIds("sender_access", "gateway_id")).toEqual(["telegram:nouva"]);
  expect(readFileSync(configPath, "utf8")).toContain("[gateways.telegram.nouva]");
  expect(readFileSync(join(agents, "nouva", "config.toml"), "utf8")).toContain('"telegram:nouva" = ["-1001234"]');
  expect(readFileSync(join(memory, EPISODE), "utf8")).toBe(episode("telegram:nouva:-1001234"));
  // The vault as it was, kept outside the weekly rotation: the one part of a rename no other copy holds.
  const snapshots = readdirSync(join(data, "backups", "memory"));
  expect(snapshots).toEqual([expect.stringMatching(/-before-rename$/)]);
  expect(readFileSync(join(data, "backups", "memory", snapshots[0]!, EPISODE), "utf8")).toBe(episode("telegram:bot:-1001234"));

  // What the next start does with them: every pack loads.
  const check = await cli("config", "check");
  expect(check.out).toContain("this configuration would start");
  expect(check.code).toBe(0);
}, 30_000);

test("a database from before the floor is refused, with the way across", async () => {
  const db = openDatabase(join(data, "nouride.db"));
  db.setUserVersion(51);
  db.close();
  const done = await cli("gateway", "rename", "telegram:bot", "telegram:nouva", "--apply");
  expect(done.code).toBe(1);
  expect(done.out).toContain("the database is at schema 51");
  expect(done.out).toContain("It is from before 0.8.0, which this build does not start on: install 0.8.0, start it once");
  expect(existsSync(join(data, "backups", "memory"))).toBe(false);
}, 30_000);
