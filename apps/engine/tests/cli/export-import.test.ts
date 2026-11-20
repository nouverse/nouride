/**
 * `nouride export` and `nouride import`, and what they are made of (`modules/transfer`): an install as one file,
 * brought into another install on real folders. Each command is run as a person runs it, in a process of its own.
 *
 * The round trip: what was exported is what the other install then holds, rows, files and secrets, under its own key
 * and at its own places. What refuses does so before anything is replaced: a wrong passphrase, a file from a newer
 * Nouride, a file that is no export, a word not typed. An import that fails at any step puts everything back. And what
 * an import does on purpose: every sign-in ended, the mission at work paused, the mark that holds it back.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { extractTarGz, openDatabase, writeTarGz, type TarEntry } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { ImportReport } from "@nouride/wire";
import { commandKeyLayout } from "@/boot/secret-store.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { VERSION } from "@/commons/version.ts";
import { openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { writeExport } from "@/modules/transfer/archive.ts";
import { heldBack, importedOf } from "@/modules/transfer/held.ts";
import { applyImport, configForHere, missingPlaces, openImport, type OpenedImport } from "@/modules/transfer/import.ts";
import { DeviceTokenStore } from "@/modules/users/devices.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { runCli } from "../cli-harness.ts";
import { cheapPasswords } from "../helpers.ts";

const PASSPHRASE = "a long walk to the river";
const NOW = 1_795_000_000_000;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const put = (path: string, text: string, mode?: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? {} : { mode });
};

/** Every file under `root` with what it holds, by its path: two trees alike have the same answer. */
function tree(root: string, skip: (path: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const rel = relative(root, path);
      if (skip(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[rel] = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
      else out[rel] = "a link";
    }
  };
  walk(root);
  return out;
}

interface Install {
  root: string;
  home: string;
  data: string;
  configPath: string;
  db: string;
}

/** An install on disk: its config, a database this build made, a key of its own. `port`: where its dashboard listens. */
async function install(name: string, port: number): Promise<Install> {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "export-import-"));
  const root = join(dir, name);
  const home = join(root, ".nouride");
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  const configPath = join(home, "config.toml");
  put(configPath, `[daemon]\nname = "${name}"\n\n[dashboard]\nport = ${port}\n`);
  (await openAndMigrate(join(data, "nouride.db"))).close();
  await SecretStore.open(data, {}, { layout: commandKeyLayout({ dataDir: data, configPath }) });
  return { root, home, data, configPath, db: join(data, "nouride.db") };
}

/** The old machine's install: agents, people, memory, documents, files, an agent's folder, accounts, work, secrets. */
async function oldMachine(): Promise<Install & { session: string; device: string }> {
  const at = await install("old", 18999);
  put(at.configPath, `[daemon]\nname = "old"\ndata_dir = "${at.data}"\n\n[dashboard]\nport = 18999\n\n[gateways.telegram.rex]\nenabled = true\ntoken = "telegram_rex"\nagent = "rex"\n\n[gateways.telegram.asleep]\ntoken = "telegram_asleep"\nagent = "rex"\nenabled = false\n\n[agents.rex]\nroots = ["/srv/projects/that-is-not-here"]\n`);
  put(join(at.home, "agents/rex/config.toml"), 'id = "rex"\ndisplay_name = "Rex"\n');
  put(join(at.home, "agents/rex/SOUL.md"), "Rex keeps the shop's books.\n");
  put(join(at.home, "agents/rex/config.toml.bak.1"), "an older config\n");
  put(join(at.home, "agents/mcp.toml"), "[servers.notion]\n");
  put(join(at.home, "agents/skills/bookkeeping/SKILL.md"), "# Bookkeeping\n");
  put(join(at.home, "agents/skills/bookkeeping/node_modules/left-pad/index.js"), "module.exports = 1;\n");
  put(join(at.home, "people/gading.toml"), 'key = "gading"\nname = "Gading"\n', 0o640);
  put(join(at.home, "memory/rex/2026-11-19.md"), "The durian is in the blue box.\n");
  put(join(at.home, "knowledge/prices.md"), "Durian: 90k\n");
  put(join(at.home, "attachments/rex/receipt.txt"), "a receipt\n");
  put(join(at.data, "uploads/photo.txt"), "a photo\n");
  put(join(at.data, "notes/rex.json"), "{}\n");
  put(join(at.home, "workspace/private/rex/ledger.md"), "the ledger\n");
  put(join(at.home, "workspace/private/rex/.cli/claude-code/default/session.json"), "a coding CLI's sign-in\n");
  put(join(at.home, "workspace/private/rex/deploy/id_ed25519.pem"), "a key\n");
  put(join(at.home, "workspace/private/rex/.npmrc"), "//registry/:_authToken=stand-in\n");
  put(join(at.home, "workspace/private/rex/app/node_modules/x/index.js"), "x\n");
  mkdirSync(join(at.home, "workspace/private/rex/empty"), { recursive: true });
  symlinkSync("/etc/hostname", join(at.home, "workspace/private/rex/a-link"));
  put(join(at.home, "workspace/shared/plan.md"), "the plan\n");
  // Never part of an export: this machine's own.
  put(join(at.data, ".control-token"), "a control token\n", 0o600);
  put(join(at.data, "backups/db/nouride-2026-11-01-00-00-00.db"), "a snapshot\n");
  put(join(at.home, "home/.claude/credentials.json"), "a sign-in\n");

  const db = openDatabase(at.db);
  const users = new UserStore({ passwords: cheapPasswords, db });
  const user = await users.create({ username: "gading", password: "correct horse battery", role: "admin", createdBy: "test" });
  const device = new DeviceTokenStore(db).create({ userId: user.id, label: "phone", now: NOW });
  const session = users.startSession(user.id).token;
  new SessionStore(db).save({ agentId: "rex", gatewayId: "telegram:rex", chatId: "8142" }, [{ role: "user", content: "hello" }, { role: "assistant", content: "I am Rex." }], 12);
  const cron = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "UTC", now: () => NOW });
  cron.create({ agentId: "rex", name: "Morning note", trigger: { kind: "every", everyMs: 3_600_000 }, target: { gatewayId: "telegram:rex", chatId: "8142" }, createdBy: "test", payload: { kind: "agentTurn", message: "good morning" } });
  db.prepare(
    `INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, title, checks, review_on, accept, status, wait_kind, reason, files, answers, told,
       workdir, untrusted, reviewed, limit_hours, limit_turns, limit_tokens, turns_used, tokens_used, resumes, waited_ms, waiting_since, progress_done, created_at, started_at, updated_at)
     VALUES (?, 'rex', '8142', 'telegram:rex', '8142', ?, ?, '["true"]', 1, 0, ?, ?, ?, '[]', '[]', '[]', '/work/x', 0, 0, 8, 50, 50000000, 3, 12000, 0, 0, ?, 0, 1000, 2000, 3000)`,
  ).run("msn_running", "write the report", "The report", "running", null, null, null);
  db.prepare(
    `INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, title, checks, review_on, accept, status, wait_kind, reason, files, answers, told,
       workdir, untrusted, reviewed, limit_hours, limit_turns, limit_tokens, turns_used, tokens_used, resumes, waited_ms, waiting_since, progress_done, created_at, started_at, updated_at)
     VALUES (?, 'rex', '8142', 'telegram:rex', '8142', ?, ?, '["true"]', 1, 0, ?, ?, ?, '[]', '[]', '[]', '/work/x', 0, 0, 8, 50, 50000000, 3, 12000, 0, 0, ?, 0, 1000, 2000, 3000)`,
  ).run("msn_asked", "ship it", "Ship it", "waiting", "input", "which box?", 2500);
  db.close();

  const store = await SecretStore.open(at.data, {}, { layout: commandKeyLayout({ dataDir: at.data, configPath: at.configPath }) });
  await store.set("telegram_rex", "stand-in-token-one", { fields: { set: { domain: "telegram.org" } } });
  await store.set("default_api_key", "stand-in-key-two");
  return { ...at, session, device: device.value };
}

/** The new machine's install, with something of its own in every place an import replaces. */
async function newMachine(): Promise<Install> {
  const at = await install("new", 18555);
  put(join(at.home, "agents/first/config.toml"), 'id = "first"\n');
  put(join(at.home, "memory/first/today.md"), "what the new machine remembered\n");
  put(join(at.home, "workspace/private/first/own.md"), "the new machine's own\n");
  const db = openDatabase(at.db);
  await new UserStore({ passwords: cheapPasswords, db }).create({ username: "setup", password: "correct horse battery", role: "admin", createdBy: "test" });
  db.close();
  const store = await SecretStore.open(at.data, {}, { layout: commandKeyLayout({ dataDir: at.data, configPath: at.configPath }) });
  await store.set("its_own", "the new machine's secret");
  return at;
}

const cli = (at: Install, args: string[], stdin = "") => runCli(args, { cwd: at.root, config: at.configPath, stdin });
const rows = <T>(path: string, sql: string): T[] => {
  const db = openDatabase(path);
  try {
    return db.prepare<T>(sql).all();
  } finally {
    db.close();
  }
};
const beforeImport = (at: Install) => readdirSync(at.home).filter((name) => name.startsWith("before-import-"));

describe("the credentials folder", () => {
  // The live box keeps it inside its agents' folder, and its first export held an agent's ssh key, a service account's
  // file and the tokens beside them, unsealed, among the packs.
  test("is never in an export, wherever the config keeps it: not among the packs it lives beside", async () => {
    const at = await install("keys", 18222);
    const kept = join(at.home, "agents/shared/.credentials");
    put(at.configPath, `[daemon]\nname = "keys"\ndata_dir = "${at.data}"\n\n[dashboard]\nport = 18222\n\n[security]\ncredentials_dir = "${kept}"\n`);
    put(join(at.home, "agents/rex/config.toml"), 'id = "rex"\ndisplay_name = "Rex"\n');
    put(join(at.home, "agents/shared/notes.md"), "what every agent may read\n");
    put(join(kept, "id_ed25519_rex"), "an ssh key\n", 0o600);
    put(join(kept, "google/tokens.json"), "{}\n", 0o600);
    const file = join(dir, "keys.tar.gz");
    const made = await cli(at, ["export", "--out", file, "--no-secrets"]);
    expect(made.code).toBe(0);
    const into = join(dir, "keys-opened");
    await extractTarGz(file, into);
    expect(existsSync(join(into, "agents/shared/notes.md"))).toBe(true);
    expect(existsSync(join(into, "agents/rex/config.toml"))).toBe(true);
    expect(existsSync(join(into, "agents/shared/.credentials"))).toBe(false);
    // Counted among what was passed over, so the file says it left something out.
    expect(JSON.parse(readFileSync(join(into, "manifest.json"), "utf8")).passed.credentials).toBe(1);
  });
});

describe("nouride export", () => {
  test("says what the file will hold before it is made, and makes one a person's own tar opens: the manifest first, no secret unsealed, nothing of this machine's", async () => {
    const old = await oldMachine();
    const file = join(dir, "nouride.tar.gz");
    const run = await cli(old, ["export", "--out", file, "--folders", "--stdin"], `${PASSPHRASE}\n`);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out.indexOf("This file will hold")).toBeLessThan(run.out.indexOf("✓"));
    expect(run.out).toContain("the agents' packs and the skills: 4 files");
    expect(run.out).toContain("2 secrets sealed to the passphrase");
    expect(run.out).not.toContain("stand-in-token-one");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const into = join(dir, "opened");
    mkdirSync(into);
    await extractTarGz(file, into);
    const held = Object.keys(tree(into)).sort();
    expect(held).toEqual(
      [
        "manifest.json", "data/nouride.db", "secrets.sealed", "config/config.toml", "config/people/gading.toml",
        "agents/mcp.toml", "agents/rex/SOUL.md", "agents/rex/config.toml", "agents/skills/bookkeeping/SKILL.md",
        "memory/rex/2026-11-19.md", "knowledge/prices.md", "attachments/rex/receipt.txt", "uploads/photo.txt", "notes/rex.json",
        "workspace/private/rex/ledger.md", "workspace/shared/plan.md",
      ].sort(),
    );
    // An agent's empty folder is still its folder.
    expect(statSync(join(into, "workspace/private/rex/empty")).isDirectory()).toBe(true);
    const manifest = JSON.parse(readFileSync(join(into, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ format: 1, product: "nouride", version: VERSION, schema: MIGRATIONS.at(-1)!.version, secrets: 2, folders: true, agents: ["rex"], passed: { links: 1, credentials: 2 } });
    // Sealed: neither secret's value is anywhere in the file as written.
    for (const path of held) expect(readFileSync(join(into, path)).includes("stand-in-token-one")).toBe(false);
  });

  test("a snapshot of the database that does not check out is no export: nothing is written", async () => {
    const old = await oldMachine();
    const { config } = await loadGlobalConfig(old.root, { quiet: true });
    const out = join(dir, "broken.tar.gz");
    const made = await writeExport({ config, configPath: old.configPath, db: { backupTo: (path) => writeFileSync(path, Buffer.alloc(8192, 7)), userVersion: () => MIGRATIONS.at(-1)!.version }, version: VERSION, agents: ["rex"], out, work: join(dir, "work"), folders: false, credential: () => false });
    expect(made).toMatchObject({ ok: false });
    expect((made as { error: string }).error).toContain("the database's snapshot did not check out");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  test("without the folders and without secrets, each said before the file is made; never over a file that is there", async () => {
    const old = await oldMachine();
    const file = join(dir, "small.tar.gz");
    const run = await cli(old, ["export", "--out", file, "--no-secrets"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Not the agents' own folders (2 files");
    expect(run.out.indexOf("No secrets go into this file")).toBeLessThan(run.out.indexOf("✓"));
    const into = join(dir, "opened");
    mkdirSync(into);
    await extractTarGz(file, into);
    expect(existsSync(join(into, "secrets.sealed"))).toBe(false);
    expect(existsSync(join(into, "workspace"))).toBe(false);
    expect(JSON.parse(readFileSync(join(into, "manifest.json"), "utf8"))).toMatchObject({ secrets: null, folders: false });

    const again = await cli(old, ["export", "--out", file, "--no-secrets"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("is already there");
    // A folder the command cannot reach: said as that, with the way on. Root's `--out ~/…` on the live box was
    // answered "/root is not a folder", the command running as the service account.
    const nowhere = await cli(old, ["export", "--out", join(dir, "no-such-folder", "x.tar.gz"), "--no-secrets"]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.err).toContain(`${join(dir, "no-such-folder")} is not a folder this command can write in.`);
    expect(nowhere.err).toContain("Nouride's commands run as its own account, whoever types them: name a folder that account can write in, such as /var/tmp.");
    const missing = await cli(old, ["import", join(dir, "no-such-file.tar.gz")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no-such-file.tar.gz is not there, or cannot be read from here.");
    expect(missing.err).toContain("put the file where that account can read it, such as /var/tmp.");
    // An install whose store holds nothing has nothing to seal: no passphrase is asked for, and the file holds none.
    const bare = await install("bare", 18111);
    const empty = await cli(bare, ["export", "--out", join(dir, "bare.tar.gz")]);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain("No secrets are kept in this install's store, so none go into the file.");
    mkdirSync(join(dir, "bare-opened"));
    await extractTarGz(join(dir, "bare.tar.gz"), join(dir, "bare-opened"));
    expect(JSON.parse(readFileSync(join(dir, "bare-opened", "manifest.json"), "utf8"))).toMatchObject({ secrets: null });
    // Neither a passphrase nor a word that there is none: asked, not guessed.
    expect((await cli(old, ["export", "--out", join(dir, "third.tar.gz")])).code).toBe(2);
    expect((await cli(old, ["export", "--out", join(dir, "short.tar.gz"), "--stdin"], "too short\n")).code).toBe(1);
    expect(existsSync(join(dir, "short.tar.gz"))).toBe(false);
  });
});

describe("an export imported into another install", () => {
  test("gives it the same rows, files and secrets, at its own places and under its own key; what it held is kept beside it", async () => {
    const old = await oldMachine();
    const fresh = await newMachine();
    const file = join(dir, "nouride.tar.gz");
    expect((await cli(old, ["export", "--out", file, "--folders", "--stdin"], `${PASSPHRASE}\n`)).code).toBe(0);
    const keyBefore = readFileSync(commandKeyLayout({ dataDir: fresh.data, configPath: fresh.configPath }).keptKey, "utf8");

    const run = await cli(fresh, ["import", file, "--stdin"], `${PASSPHRASE}\nreplace\n`);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain("It replaces everything this install holds: 1 agent (first)");
    expect(run.out).toContain("imported, from Nouride");
    expect(run.out).toContain("Not live yet. 1 connection and 1 automation wait, and 1 mission was paused.");
    expect(run.out).toContain("agents.rex.roots[0] names /srv/projects/that-is-not-here, which is not on this machine.");
    expect(run.out).not.toContain("stand-in-token-one");

    // The files: every part as the old machine had it, without what an export never holds.
    const exported = (path: string) => /node_modules|\.bak\.\d+$/.test(path);
    for (const part of ["agents", "people", "memory", "knowledge", "attachments", "workspace/shared"]) expect({ part, files: tree(join(fresh.home, part)) }).toEqual({ part, files: tree(join(old.home, part), exported) });
    for (const part of ["uploads", "notes"]) expect(tree(join(fresh.data, part))).toEqual(tree(join(old.data, part)));
    expect(Object.keys(tree(join(fresh.home, "workspace/private")))).toEqual(["rex/ledger.md"]);
    expect(existsSync(join(fresh.home, "workspace/private/rex/empty"))).toBe(true);
    expect(statSync(join(fresh.home, "people/gading.toml")).mode & 0o777).toBe(0o640);
    // The new machine's own are no longer in place.
    expect(existsSync(join(fresh.home, "agents/first"))).toBe(false);
    expect(existsSync(join(fresh.data, ".control-token"))).toBe(false);

    // The config: the old machine's, at the new machine's places.
    const config = readFileSync(fresh.configPath, "utf8");
    expect(config).toContain('name = "old"');
    expect(config).toContain("[gateways.telegram.rex]");
    expect(config).toContain("port = 18555");
    expect(config).not.toContain("18999");
    expect(config).not.toContain("data_dir");

    // The secrets: the same names, values and fields, readable with the key this machine had before.
    const layout = commandKeyLayout({ dataDir: fresh.data, configPath: fresh.configPath });
    expect(readFileSync(layout.keptKey, "utf8")).toBe(keyBefore);
    const store = await SecretStore.open(fresh.data, {}, { layout });
    expect(JSON.parse(store.sealedCopyText()).secrets).toMatchObject({ telegram_rex: { value: "stand-in-token-one", fields: { domain: "telegram.org" } }, default_api_key: { value: "stand-in-key-two" } });
    expect(store.has("its_own")).toBe(false);

    // The rows: what happened and what was set up, as they were.
    for (const table of ["users", "sessions", "session_messages", "cron_jobs"]) {
      expect({ table, rows: rows(fresh.db, `SELECT * FROM ${table} ORDER BY 1`) }).toEqual({ table, rows: rows(old.db, `SELECT * FROM ${table} ORDER BY 1`) });
    }
    expect(rows<{ id: string }>(fresh.db, "SELECT id FROM users").length).toBe(1);

    // What it held before, whole, in a folder beside it.
    const [kept] = beforeImport(fresh);
    expect(kept).toBeDefined();
    const was = tree(join(fresh.home, kept!));
    expect(Object.keys(was)).toEqual(expect.arrayContaining(["agents/first/config.toml", "memory/first/today.md", "workspace/private/first/own.md", "config/config.toml", "data/nouride.db", "data/secrets.enc"]));
    expect(rows<{ username: string }>(join(fresh.home, kept!, "data/nouride.db"), "SELECT username FROM users")).toEqual([{ username: "setup" }]);
    expect(existsSync(join(fresh.home, "import-staging"))).toBe(false);
  });

  test("ends every session and every device's token, pauses the mission at work and leaves the one that asked, and is held back until it goes live", async () => {
    const old = await oldMachine();
    const fresh = await newMachine();
    const file = join(dir, "nouride.tar.gz");
    expect((await cli(old, ["export", "--out", file, "--stdin"], `${PASSPHRASE}\n`)).code).toBe(0);
    expect(rows<{ n: number }>(old.db, "SELECT COUNT(*) AS n FROM user_sessions")[0]!.n).toBe(1);
    expect((await cli(fresh, ["import", file, "--stdin"], `${PASSPHRASE}\nreplace\n`)).code).toBe(0);

    const db = openDatabase(fresh.db);
    try {
      const users = new UserStore({ passwords: cheapPasswords, db });
      expect(users.session(old.session)).toBeNull();
      expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM user_sessions").get()!.n).toBe(0);
      expect(db.prepare<{ revoked_at: number | null }>("SELECT revoked_at FROM device_tokens").all().every((row) => row.revoked_at !== null)).toBe(true);
      expect(new DeviceTokenStore(db).use(old.device, Date.now())).toBeNull();
      // The account itself came, with its password: that is who signs in.
      expect(await users.verify("gading", "correct horse battery")).not.toBeNull();

      const missions = new MissionStore(db);
      expect(missions.get("msn_running")).toMatchObject({ status: "waiting", waitKind: "paused", pausedBy: "the import" });
      expect(missions.get("msn_asked")).toMatchObject({ status: "waiting", waitKind: "input", reason: "which box?", pausedBy: null });

      const state = new DaemonStateStore(db);
      expect(heldBack(state)).toBe(true);
      expect(importedOf(state)!.from.version).toBe(VERSION);
      expect(importedOf(state)).toMatchObject({
        agents: ["rex"],
        secrets: 2,
        folders: false,
        ended: { sessions: 1, devices: 1 },
        held: { connections: ["telegram:rex"], automations: 1, missions: 1 },
        missing: [{ setting: "agents.rex.roots[0]", path: "/srv/projects/that-is-not-here" }],
        live: false,
      } satisfies Partial<ImportReport>);
    } finally {
      db.close();
    }
    // Without the folders in the file, the new machine's agents' folders are left as they were.
    expect(existsSync(join(fresh.home, "workspace/private/first/own.md"))).toBe(true);
    // The old machine is as it was: an export reads.
    expect(rows<{ n: number }>(old.db, "SELECT COUNT(*) AS n FROM user_sessions")[0]!.n).toBe(1);
  });

  test("with no secrets in the file, the install holds none after it, and says so", async () => {
    const old = await oldMachine();
    const fresh = await newMachine();
    const file = join(dir, "nouride.tar.gz");
    expect((await cli(old, ["export", "--out", file, "--no-secrets"])).code).toBe(0);
    const run = await cli(fresh, ["import", file, "--stdin"], `\nreplace\n`);
    expect(run.code).toBe(0);
    expect(run.out).toContain("The file held no secrets");
    const store = await SecretStore.open(fresh.data, {}, { layout: commandKeyLayout({ dataDir: fresh.data, configPath: fresh.configPath }) });
    expect(JSON.parse(store.sealedCopyText()).secrets).toEqual({});
  });
});

describe("refused before anything is replaced", () => {
  /** The new machine with an export beside it, and its every file as it stands. */
  async function ready() {
    const old = await oldMachine();
    const fresh = await newMachine();
    const file = join(dir, "nouride.tar.gz");
    expect((await cli(old, ["export", "--out", file, "--folders", "--stdin"], `${PASSPHRASE}\n`)).code).toBe(0);
    return { old, fresh, file, before: tree(fresh.home) };
  }

  test("a passphrase that does not open the file's secrets, and none at all", async () => {
    const { fresh, file, before } = await ready();
    for (const stdin of ["not the passphrase at all\nreplace\n", "\nreplace\n"]) {
      const run = await cli(fresh, ["import", file, "--stdin"], stdin);
      expect(run.code).toBe(1);
      expect(run.err).toContain("That passphrase does not open this file's secrets.");
      expect(run.err).toContain("Nothing was changed.");
      expect(tree(fresh.home)).toEqual(before);
    }
  });

  test("the word not typed, or another one", async () => {
    const { fresh, file, before } = await ready();
    for (const word of ["", "yes", "Replace"]) {
      const run = await cli(fresh, ["import", file, "--stdin"], `${PASSPHRASE}\n${word}\n`);
      expect(run.code).toBe(1);
      expect(run.err).toContain("Nothing was changed");
      expect(tree(fresh.home)).toEqual(before);
    }
  });

  test("a file made by a newer Nouride: Update Nouride first", async () => {
    const { old, fresh, before } = await ready();
    const loaded = await loadGlobalConfig(old.root, { quiet: true });
    const db = openDatabase(old.db);
    const work = join(dir, "work");
    mkdirSync(work);
    try {
      for (const [name, version, schema] of [["newer-release", "99.0.0", null], ["newer-database", VERSION, MIGRATIONS.at(-1)!.version + 1]] as const) {
        const file = join(dir, `${name}.tar.gz`);
        const made = await writeExport({ config: loaded.config, configPath: old.configPath, db: schema === null ? db : { backupTo: (path) => db.backupTo(path), userVersion: () => schema }, version, agents: ["rex"], out: file, work, folders: false, credential: () => false });
        expect(made.ok).toBe(true);
        const run = await cli(fresh, ["import", file, "--stdin"], `\nreplace\n`);
        expect(run.code).toBe(1);
        expect(run.err).toContain("Update Nouride first.");
        expect(tree(fresh.home)).toEqual(before);
      }
    } finally {
      db.close();
    }
  });

  test("a file that is no export, one cut short, one whose database is damaged; and while Nouride runs", async () => {
    const { fresh, file, before } = await ready();
    const other = join(dir, "other.tar.gz");
    await writeTarGz(other, [{ name: "notes.txt", bytes: new TextEncoder().encode("not an install") }]);
    const cut = join(dir, "cut.tar.gz");
    writeFileSync(cut, readFileSync(file).subarray(0, 2_000));
    const opened = join(dir, "opened");
    mkdirSync(opened);
    await extractTarGz(file, opened);
    // Its first page whole, so it still says which version made it; the pages after it overwritten.
    const database = readFileSync(join(opened, "data/nouride.db"));
    database.fill(7, 8192, 8192 * 6);
    writeFileSync(join(opened, "data/nouride.db"), database);
    const damaged = join(dir, "damaged.tar.gz");
    await writeTarGz(damaged, Object.keys(tree(opened)).sort((a) => (a === "manifest.json" ? -1 : 0)).map((name): TarEntry => ({ name, from: join(opened, name), size: statSync(join(opened, name)).size })));

    for (const [bad, says] of [[other, "This file is not an export of Nouride."], [cut, "This file could not be read to its end."], [damaged, "The database in this file is damaged."]] as const) {
      const run = await cli(fresh, ["import", bad, "--stdin"], `${PASSPHRASE}\nreplace\n`);
      expect({ bad, code: run.code }).toEqual({ bad, code: 1 });
      expect(run.err).toContain(says);
      expect(tree(fresh.home)).toEqual(before);
    }
    // A daemon holds the database open: its lock names a process that is alive and reads as one.
    const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000); // a stand-in for nouride start"], { stdio: "ignore" });
    try {
      put(join(fresh.data, "nouride.lock"), `${daemon.pid}\n`);
      const running = await cli(fresh, ["import", file, "--stdin"], `${PASSPHRASE}\nreplace\n`);
      expect(running.code).toBe(1);
      expect(running.err).toContain("The daemon is running");
    } finally {
      daemon.kill("SIGKILL");
    }
    rmSync(join(fresh.data, "nouride.lock"));
    expect(tree(fresh.home)).toEqual(before);
  });
});

describe("an import that fails halfway", () => {
  test("puts back everything this install held, whichever step it stopped at, and keeps no folder of it", async () => {
    const old = await oldMachine();
    const fresh = await newMachine();
    const file = join(dir, "nouride.tar.gz");
    expect((await cli(old, ["export", "--out", file, "--folders", "--stdin"], `${PASSPHRASE}\n`)).code).toBe(0);
    // Not the database's `-shm`: SQLite's own index of its log, written anew by whoever opens the database, the import's
    // undone migration and this test's reads among them. On macOS it came back with other bytes over the same rows.
    const index = (path: string) => path.endsWith(".db-shm");
    const before = tree(fresh.home, index);
    const { config } = await loadGlobalConfig(fresh.root, { quiet: true });
    const store = { env: {}, layout: commandKeyLayout({ dataDir: fresh.data, configPath: fresh.configPath }) };

    for (const stopAt of ["config", "database", "secrets", "migrate", "mark"]) {
      const opened = (await openImport({ file, staging: join(fresh.home, "import-staging"), passphrase: PASSPHRASE, version: VERSION })) as OpenedImport;
      expect(opened.ok).toBe(true);
      const kept = join(fresh.home, `before-import-${stopAt}`);
      const done = await applyImport({ opened, config, configPath: fresh.configPath, kept, store, before: (step) => { if (step === stopAt) throw new Error(`the disk gave out at ${step}`); } });
      expect({ stopAt, done }).toEqual({ stopAt, done: { ok: false, error: `the disk gave out at ${stopAt}`, restored: true } });
      expect(existsSync(kept)).toBe(false);
      // Everything of the install is as it was: its files byte for byte, its database opened and read.
      const now = tree(fresh.home, (path) => path.startsWith("import-staging") || path.startsWith("data/backups") || index(path));
      expect({ stopAt, now }).toEqual({ stopAt, now: before });
      expect(rows<{ username: string }>(fresh.db, "SELECT username FROM users")).toEqual([{ username: "setup" }]);
      const secrets = await SecretStore.open(fresh.data, {}, { layout: store.layout });
      expect(secrets.has("its_own")).toBe(true);
    }
    // And the same file then goes in whole.
    const opened = (await openImport({ file, staging: join(fresh.home, "import-staging"), passphrase: PASSPHRASE, version: VERSION })) as OpenedImport;
    const done = await applyImport({ opened, config, configPath: fresh.configPath, kept: join(fresh.home, "before-import-last"), store });
    expect(done.ok).toBe(true);
    expect(existsSync(join(fresh.home, "agents/rex/SOUL.md"))).toBe(true);
  });
});

describe("the config an import writes", () => {
  test("keeps this machine's own places, and drops the old machine's where this one names none", () => {
    const theirs = '[daemon]\nname = "old"\ndata_dir = "/old/data"\nbackup_dir = "/mnt/usb"\n\n[dashboard]\nhost = "0.0.0.0"\nport = 18999\n\n[memory]\ndir = "/old/memory"\nhalf_life_days = 30\n';
    const here = '[daemon]\nname = "new"\nagents_dir = "/new/agents"\n\n[dashboard]\nport = 18555\n';
    const text = configForHere(theirs, here);
    expect(text).toContain('name = "old"');
    expect(text).toContain('agents_dir = "/new/agents"');
    expect(text).toContain("port = 18555");
    expect(text).toContain("half_life_days = 30");
    for (const gone of ["/old/data", "/mnt/usb", "0.0.0.0", "18999", "/old/memory"]) expect(text).not.toContain(gone);
  });

  test("a setting that names a place not on this machine is listed, with the place", () => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "export-import-"));
    const text = `[daemon]\nname = "x"\n\n[agents.rex]\nroots = ["${dir}", "/srv/gone/project"]\n\n[web]\nurl = "https://example.com/a"\n`;
    expect(missingPlaces(text)).toEqual([{ setting: "agents.rex.roots[1]", path: "/srv/gone/project" }]);
  });
});
