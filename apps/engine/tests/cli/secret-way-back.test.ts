/**
 * The CLI around the encrypted store (0.8.19): `secret decrypt` (the way back to a version that reads `secrets.json`),
 * `secret restore` (the secrets back from the copy sealed to the backup passphrase, for a lost key or a moved install),
 * and the fields `secret set --field` and `secret field` send. Each local command run in a process of its own, as a
 * person runs it, against an install's real files.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "@nouride/secrets";
import { commandKeyLayout } from "@/boot/secret-store.ts";
import type { Client } from "@nouride/cli-kit";
import { secret } from "../../../cli/src/commands/secret.ts";
import { backupSealFor, sealedSecretsCopy } from "@/modules/config/sealed-secrets.ts";
import { runCli } from "../cli-harness.ts";

const PASSPHRASE = "a long walk to the river";
const engine = join(import.meta.dir, "..", "..");
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** An install whose store holds two secrets, encrypted with a key the daemon kept in `.nouride/`. */
async function install() {
  dir = mkdtempSync(join(tmpdir(), "secret-way-back-"));
  const home = join(dir, ".nouride");
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "home"\n');
  const layout = commandKeyLayout({ dataDir, configPath });
  const store = await SecretStore.open(dataDir, {}, { layout });
  await store.set("telegram_bot", "stand-in-token-one", { fields: { set: { domain: "telegram.org" } } });
  await store.set("default_api_key", "stand-in-key-two");
  return { home, dataDir, configPath, layout, store };
}

function cli(configPath: string, args: string[], input = "") {
  const script = `import { decryptSecrets } from "@/cli/commands/secret-decrypt.ts"; import { restoreSecrets } from "@/cli/commands/secret-restore.ts";
    const args = ${JSON.stringify(args)}; await (args[0] === "decrypt" ? decryptSecrets(args.slice(1)) : restoreSecrets(args.slice(1)));`;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: engine, input, timeout: 30_000, encoding: "utf8", env: { ...process.env, NOURIDE_CONFIG: configPath } });
  return { status: run.status, out: plain(`${run.stdout}${run.stderr}`) };
}

describe("nouride secret decrypt", () => {
  test("writes secrets.json's map of names and values at 0600 for an older version; none of it on the screen", async () => {
    const at = await install();
    const out = join(dir, "secrets.json");
    const run = cli(at.configPath, ["decrypt", "--out", out]);
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ telegram_bot: "stand-in-token-one", default_api_key: "stand-in-key-two" });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(run.out).not.toContain("stand-in-token-one");
    expect(run.out).toContain("put it at .nouride/data/secrets.json");
  });

  test("never over a file that is there, and asks where to without --out", async () => {
    const at = await install();
    const out = join(dir, "taken.json");
    writeFileSync(out, "something of someone's");
    expect(cli(at.configPath, ["decrypt", "--out", out]).status).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("something of someone's");
    expect(cli(at.configPath, ["decrypt"]).status).toBe(2);
  });

  test("a store whose key is not here is refused by name, and nothing is written", async () => {
    const at = await install();
    rmSync(at.layout.keptKey);
    const out = join(dir, "secrets.json");
    const run = cli(at.configPath, ["decrypt", "--out", out]);
    expect(run.status).toBe(1);
    expect(run.out).toContain("is encrypted with a key this machine does not have");
    expect(existsSync(out)).toBe(false);
  });
});

describe("the key the launcher hands a command run by root", () => {
  const key = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";

  test("leaves its environment before the command runs, so nothing the command starts inherits it", async () => {
    const { configPath } = await install();
    const at = join(dir, "key-at-exit");
    const run = await runCli(["version"], { cwd: dir, config: configPath, env: { NOURIDE_ENCRYPTION_KEY: key, KEY_AT_EXIT: at }, preload: join(import.meta.dir, "fixtures/key-at-exit.ts") });
    expect(run.code).toBe(0);
    expect(readFileSync(at, "utf8")).toBe("gone");
  });

  test("and `secret decrypt` opens a store encrypted under it, the key kept nowhere in the install", async () => {
    dir = mkdtempSync(join(tmpdir(), "secret-way-back-"));
    const dataDir = join(dir, ".nouride", "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(dir, ".nouride", "config.toml");
    writeFileSync(configPath, '[daemon]\nname = "home"\n');
    await (await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: key }, { layout: commandKeyLayout({ dataDir, configPath }) })).set("telegram_bot", "stand-in-token-one");
    expect(existsSync(join(dir, ".nouride", "encryption.key"))).toBe(false);
    const out = join(dir, "secrets.json");
    const run = await runCli(["secret", "decrypt", "--out", out], { cwd: dir, config: configPath, env: { NOURIDE_ENCRYPTION_KEY: key } });
    expect(run.code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ telegram_bot: "stand-in-token-one" });
  });
});

describe("nouride secret restore", () => {
  test("a lost key: the sealed copy opens with the passphrase, the store is written under a new key, the old file set aside", async () => {
    const at = await install();
    sealedSecretsCopy(at.dataDir, backupSealFor(PASSPHRASE), at.store.sealedCopyText());
    rmSync(at.layout.keptKey);
    const run = cli(at.configPath, ["restore", "--stdin"], `${PASSPHRASE}\n`);
    expect(run.status).toBe(0);
    expect(run.out).toContain("2 secret(s) restored");
    expect(run.out).toContain("the store this could not open is kept as");
    expect(run.out).not.toContain("stand-in-token-one");
    expect(readdirSync(at.dataDir).some((name) => name.startsWith("secrets.enc.unopened-"))).toBe(true);
    const reopened = await SecretStore.open(at.dataDir, {}, { layout: at.layout });
    expect(reopened.resolve("telegram_bot")).toBe("stand-in-token-one");
    expect(reopened.describe("telegram_bot")?.fields).toEqual({ domain: "telegram.org" });
  });

  test("a wrong passphrase changes nothing; a running Nouride is not restored under", async () => {
    const at = await install();
    sealedSecretsCopy(at.dataDir, backupSealFor(PASSPHRASE), at.store.sealedCopyText());
    const before = readFileSync(join(at.dataDir, "secrets.enc"));
    const wrong = cli(at.configPath, ["restore", "--stdin"], "not the passphrase at all\n");
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain("did not open");
    expect(readFileSync(join(at.dataDir, "secrets.enc")).equals(before)).toBe(true);
    // A process whose command line names Nouride stands in for a daemon holding the lock, as the other lock tests do.
    const holder = spawn("sh", ["-c", "sleep 30; :", "nouride-lock-holder"]);
    try {
      writeFileSync(join(at.dataDir, "nouride.lock"), `${holder.pid}\n`);
      const running = cli(at.configPath, ["restore", "--stdin"], `${PASSPHRASE}\n`);
      expect(running.status).toBe(1);
      expect(running.out).toContain("Nouride is running, so it opens its secrets");
    } finally {
      holder.kill();
    }
  });
});

describe("nouride secret set --field and secret field", () => {
  async function run(args: string[]): Promise<{ sent: { method: string; path: string; body: unknown }[]; out: string }> {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const client = {
      put: async (path: string, body: unknown) => (sent.push({ method: "PUT", path, body }), { ok: true }),
      patch: async (path: string, body: unknown) => (sent.push({ method: "PATCH", path, body }), { fields: { domain: "github.com", username: "nouva-bot" } }),
    } as unknown as Client;
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
    try {
      await secret(client, args);
    } finally {
      log.mockRestore();
    }
    return { sent, out: lines.join("\n") };
  }

  test("--field name=text, repeated, goes with the value", async () => {
    const { sent } = await run(["set", "github", "--value", "ghp_stand_in", "--field", "domain=github.com", "--field", "username=nouva-bot"]);
    expect(sent).toEqual([{ method: "PUT", path: "/secrets/github", body: { value: "ghp_stand_in", fields: { set: { domain: "github.com", username: "nouva-bot" } } } }]);
  });

  test("field sets and removes, the value left alone, and says what it says now", async () => {
    const { sent, out } = await run(["field", "github", "username=nouva-bot", "--remove", "note"]);
    expect(sent).toEqual([{ method: "PATCH", path: "/secrets/github/fields", body: { set: { username: "nouva-bot" }, remove: ["note"] } }]);
    expect(out).toContain("github domain: github.com · username: nouva-bot");
  });
});
