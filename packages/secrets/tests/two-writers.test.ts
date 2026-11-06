/**
 * Two processes on one store file (0.8.15): a running daemon, and `nouride setup` beside it, as the Docker docs run it.
 *
 * Each held the copy it read when it opened. Setup wrote the provider key; the daemon's next write — the `nouride secret
 * set` that followed — put back its own copy, read at boot, and the key was gone. A fresh install under Nix's benchmark
 * answered nothing on Telegram until the key was set again (2026-11-02).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "two-writers-"));
  dirs.push(dir);
  return dir;
};

const KEY = "provider-value-0123456789abcdef";
const TOKEN = "bot-value-fedcba9876543210";

describe("a store another process writes to", () => {
  test("a value it stored is not lost by this store's next write", async () => {
    const dir = dataDir();
    const daemon = await SecretStore.open(dir, {});
    const setup = await SecretStore.open(dir, {});
    await setup.set("default_api_key", KEY);
    await daemon.set("telegram_bot_token", TOKEN);
    const after = await SecretStore.open(dir, {});
    expect(after.resolve("default_api_key")).toBe(KEY);
    expect(after.resolve("telegram_bot_token")).toBe(TOKEN);
  });

  test("the running store has it without a restart", async () => {
    const dir = dataDir();
    const daemon = await SecretStore.open(dir, {});
    expect(daemon.resolve("default_api_key")).toBeUndefined();
    await (await SecretStore.open(dir, {})).set("default_api_key", KEY);
    expect(daemon.resolve("default_api_key")).toBe(KEY);
  });

  test("and lists what the file holds, not what it read at its start", async () => {
    const dir = dataDir();
    const daemon = await SecretStore.open(dir, {});
    await (await SecretStore.open(dir, {})).set("default_api_key", KEY);
    expect(daemon.inventory().map((entry) => entry.name)).toEqual(["default_api_key"]);
  });

  test("a delete here takes its own name and no other", async () => {
    const dir = dataDir();
    const daemon = await SecretStore.open(dir, {});
    await daemon.set("telegram_bot_token", TOKEN);
    await (await SecretStore.open(dir, {})).set("default_api_key", KEY);
    expect(await daemon.delete("telegram_bot_token")).toBe(true);
    const after = await SecretStore.open(dir, {});
    expect(after.resolve("default_api_key")).toBe(KEY);
    expect(after.resolve("telegram_bot_token")).toBeUndefined();
  });

  test("several written at once keep what the other process wrote", async () => {
    const dir = dataDir();
    const daemon = await SecretStore.open(dir, {});
    await (await SecretStore.open(dir, {})).set("default_api_key", KEY);
    await daemon.setMany({ oauth_access: "access-value-0123456789", oauth_refresh: "refresh-value-0123456789" });
    const after = await SecretStore.open(dir, {});
    expect(after.resolve("default_api_key")).toBe(KEY);
    expect(after.resolve("oauth_refresh")).toBe("refresh-value-0123456789");
  });
});
