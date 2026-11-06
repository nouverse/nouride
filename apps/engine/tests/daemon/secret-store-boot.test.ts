/**
 * The secret store at boot (0.8.19, `boot/secret-store.ts`): the key's variables out of the daemon's own environment
 * once read; `secrets.json` moved into `secrets.enc` at once when no update is pending, and only after one settles when
 * one is (the guard's way back reads `secrets.json`); the copy sealed to the backup password made again at each change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithPassphrase, removePath } from "@nouride/runtime";
import { keepStoreKeyAside, openCommandSecretStore, openSecretStore, settleSecretStore } from "@/boot/secret-store.ts";
import { backupSealFor } from "@/modules/config/sealed-secrets.ts";
import { eventually } from "../wait.ts";

let install: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), "secret-store-boot-"));
  dataDir = join(install, ".nouride", "data");
  configPath = join(install, ".nouride", "config.toml");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, "");
  writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ telegram_bot: "123:stand-in" }), { mode: 0o600 });
});

afterEach(() => {
  delete process.env.NOURIDE_ENCRYPTION_KEY;
  delete process.env.NOURIDE_ENCRYPTION_KEY_FILE;
  keepStoreKeyAside();
  removePath(install);
});

describe("opening", () => {
  test("the key's variables are read, then gone from the daemon's environment: nothing it starts inherits them", async () => {
    process.env.NOURIDE_ENCRYPTION_KEY = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";
    const secrets = await openSecretStore({ dataDir, configPath });
    expect(process.env.NOURIDE_ENCRYPTION_KEY).toBeUndefined();
    expect(secrets.lock().key).toEqual({ where: "the environment", level: "outside" });
    const child = spawnSync("sh", ["-c", "printf %s \"${NOURIDE_ENCRYPTION_KEY:-none}\""], { encoding: "utf8" });
    expect(child.stdout).toBe("none");
  });

  test("with no key anywhere and the install's .env, the key the move makes is a line there, beside .nouride/", async () => {
    writeFileSync(join(install, ".env"), "PORT=18254\n", { mode: 0o600 });
    const secrets = await openSecretStore({ dataDir, configPath });
    settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => "", pending: () => false });
    await eventually(() => existsSync(join(dataDir, "secrets.enc")));
    expect(readFileSync(join(install, ".env"), "utf8")).toMatch(/^PORT=18254\n# The secret store's key .*\nNOURIDE_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=\n$/);
    expect(secrets.lock().key).toEqual({ where: join(install, ".env"), level: "install" });
    expect(existsSync(join(install, ".nouride", "encryption.key"))).toBe(false);
  });
});

describe("a command run outside the service", () => {
  test("the key the launcher hands it leaves its environment as it starts: nothing it runs inherits it, and the store opens with it", async () => {
    const key = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";
    process.env.NOURIDE_ENCRYPTION_KEY = key;
    const daemon = await openSecretStore({ dataDir, configPath });
    settleSecretStore(daemon, { dataDir, installDir: install, version: "0.8.19", seal: () => "", pending: () => false });
    await eventually(() => existsSync(join(dataDir, "secrets.enc")) && !existsSync(join(dataDir, "secrets.json")));

    process.env.NOURIDE_ENCRYPTION_KEY = key;
    keepStoreKeyAside();
    expect(process.env.NOURIDE_ENCRYPTION_KEY).toBeUndefined();
    const child = spawnSync("sh", ["-c", "printf %s \"${NOURIDE_ENCRYPTION_KEY:-none}\""], { encoding: "utf8" });
    expect(child.stdout).toBe("none");
    expect((await openCommandSecretStore({ dataDir, configPath })).resolve("telegram_bot")).toBe("123:stand-in");
  });
});

describe("moving secrets.json", () => {
  test("no update pending: moved at once, the plain file gone, every value there", async () => {
    const secrets = await openSecretStore({ dataDir, configPath });
    expect(settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => "", pending: () => false })).toBeNull();
    await eventually(() => !existsSync(join(dataDir, "secrets.json")));
    expect(existsSync(join(dataDir, "secrets.enc"))).toBe(true);
    expect((await openSecretStore({ dataDir, configPath })).resolve("telegram_bot")).toBe("123:stand-in");
  });

  test("an update pending: left as the previous version reads it, and moved once it is confirmed", async () => {
    let pending = true;
    let asked = 0;
    const secrets = await openSecretStore({ dataDir, configPath });
    const timer = settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => "", pending: () => (asked++, pending), checkEveryMs: 20 });
    try {
      expect(timer).not.toBeNull();
      // Asked again and again while it is pending, and nothing moved in all that time.
      await eventually(() => asked >= 4);
      expect(existsSync(join(dataDir, "secrets.json"))).toBe(true);
      expect(existsSync(join(dataDir, "secrets.enc"))).toBe(false);
      pending = false;
      await eventually(() => !existsSync(join(dataDir, "secrets.json")));
      expect(existsSync(join(dataDir, "secrets.enc"))).toBe(true);
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  test("a marker for another version is stale (a hand's rollback, a test's), and holds nothing back", async () => {
    // The box sandbox's setup writes one for 0.7.10: the move waited a minute on it before confirm.ts removed it.
    writeFileSync(join(install, ".nouride-pending-update"), JSON.stringify({ from: "0.7.9", to: "0.7.10" }));
    const secrets = await openSecretStore({ dataDir, configPath });
    expect(settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => "" })).toBeNull();
    await eventually(() => existsSync(join(dataDir, "secrets.enc")) && !existsSync(join(dataDir, "secrets.json")));
  });

  test("the guard's marker beside the binary is what pending means", async () => {
    writeFileSync(join(install, ".nouride-pending-update"), JSON.stringify({ from: "0.8.18", to: "0.8.19" }));
    const secrets = await openSecretStore({ dataDir, configPath });
    const timer = settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => "", checkEveryMs: 20 });
    try {
      expect(existsSync(join(dataDir, "secrets.json"))).toBe(true);
      removePath(join(install, ".nouride-pending-update"));
      await eventually(() => existsSync(join(dataDir, "secrets.enc")));
    } finally {
      if (timer) clearInterval(timer);
    }
  });
});

describe("the copy sealed to the backup password", () => {
  test("made again at each change, so a lost key is recovered to the store as it was, not as it was a week ago", async () => {
    const passphrase = "a long walk to the sea and back";
    const seal = backupSealFor(passphrase);
    const secrets = await openSecretStore({ dataDir, configPath });
    settleSecretStore(secrets, { dataDir, installDir: install, version: "0.8.19", seal: () => seal, pending: () => false });
    await eventually(() => existsSync(join(dataDir, "secrets.sealed")));
    await secrets.set("github", "ghp_stand_in", { fields: { set: { domain: "github.com" } } });
    const opened = JSON.parse(new TextDecoder().decode(openWithPassphrase(passphrase, readFileSync(join(dataDir, "secrets.sealed"))))) as {
      secrets: Record<string, { value: string; fields: Record<string, string> }>;
    };
    expect(opened.secrets.github).toMatchObject({ value: "ghp_stand_in", fields: { domain: "github.com" } });
    expect(opened.secrets.telegram_bot?.value).toBe("123:stand-in");
  });
});
