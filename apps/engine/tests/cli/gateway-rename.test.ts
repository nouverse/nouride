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
import { readConfigText } from "@/modules/config/global/index.ts";
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

const NUMBER = (more = "") => `\n[gateways.whatsapp.main]\nenabled = false\nencryption_key = "whatsapp-main-key"\n${more}`;
/** Where the loader has a connection keep its login, read from the file as the next start reads it. */
const loginOf = (id: string) => readConfigText(readFileSync(configPath, "utf8"), configPath).gateways.find((gateway) => gateway.id === id)?.sessionDir;

test("a WhatsApp login kept in the folder named for its connection moves with the name, so the number stays linked", async () => {
  put(configPath, CONFIG({ data, agents, memory }) + NUMBER());
  const [before, after] = [join(data, "whatsapp-main"), join(data, "whatsapp-shop")];
  put(join(before, "creds.enc"), "encrypted-login-bytes");
  expect(loginOf("whatsapp:main")).toBe(before);

  const dry = await cli("gateway", "rename", "whatsapp:main", "whatsapp:shop");
  expect(dry.out).toContain(`its WhatsApp login moves with it: ${before} → ${after}`);
  expect([existsSync(before), existsSync(after)]).toEqual([true, false]);

  const done = await cli("gateway", "rename", "whatsapp:main", "whatsapp:shop", "--apply");
  expect(done.code).toBe(0);
  expect(done.out).toContain(`Its WhatsApp login moved with it (${after}), so no re-link is needed.`);
  // The folder the renamed connection reads is the one its login is now in.
  expect(loginOf("whatsapp:shop")).toBe(after);
  expect([existsSync(before), readFileSync(join(after, "creds.enc"), "utf8")]).toEqual([false, "encrypted-login-bytes"]);
}, 30_000);

test("a login whose folder the connection's table names stays where it is", async () => {
  const kept = join(root, "wa-login");
  put(configPath, CONFIG({ data, agents, memory }) + NUMBER(`session_dir = "${kept}"\n`));
  put(join(kept, "creds.enc"), "encrypted-login-bytes");
  // A folder that only looks like the connection's own is not touched either.
  put(join(data, "whatsapp-main", "creds.enc"), "another login, of no connection here");
  const done = await cli("gateway", "rename", "whatsapp:main", "whatsapp:shop", "--apply");
  expect(done.code).toBe(0);
  expect(done.out).not.toContain("moves with it");
  expect(done.out).toContain("The WhatsApp pairing is keyed by session_dir, not by the id, so no re-link is needed.");
  expect(loginOf("whatsapp:shop")).toBe(kept);
  expect([existsSync(join(kept, "creds.enc")), existsSync(join(data, "whatsapp-main", "creds.enc")), existsSync(join(data, "whatsapp-shop"))]).toEqual([true, true, false]);
}, 30_000);

test("refused when the new name's folder is already there: nothing is renamed, and neither login is touched", async () => {
  put(configPath, CONFIG({ data, agents, memory }) + NUMBER());
  put(join(data, "whatsapp-main", "creds.enc"), "the connection's login");
  put(join(data, "whatsapp-shop", "creds.enc"), "what was there");
  const before = readFileSync(configPath, "utf8");
  const refused = await cli("gateway", "rename", "whatsapp:main", "whatsapp:shop", "--apply");
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`Nothing was renamed: whatsapp:main's WhatsApp login would move to ${join(data, "whatsapp-shop")}, and something is already there.`);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect([readFileSync(join(data, "whatsapp-main", "creds.enc"), "utf8"), readFileSync(join(data, "whatsapp-shop", "creds.enc"), "utf8")]).toEqual(["the connection's login", "what was there"]);
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
