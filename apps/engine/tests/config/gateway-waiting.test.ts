/**
 * A connection's row says what it waits on: the connections the dashboard lists carry the reason a connection
 * that is not up yet gave, since when, and until when where its chat app named a time; one that waits on nothing, is
 * connected, or is not running yet carries none.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SecretStore } from "@nouride/secrets";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";

let dir: string;
let config: GlobalConfig;
let settings: SettingsService;
/** Each connection as it is live, by id: what the daemon's own gateways answer. */
const live = new Map<string, { status: string; waiting?: { reason: string; since: number; until?: number } | null }>();

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-gateway-waiting-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "nouride"\n');
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [{ id: "telegram:nouva", platform: "telegram", name: "nouva", enabled: true, tokenSecret: "telegram-nouva", agent: "nouva" }] as GlobalConfig["gateways"];
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => live, retireGateway: async () => ({ stopped: true, loggedOut: true }) });
});

afterEach(() => {
  live.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe("a connection's row says what it waits on", () => {
  test("one that is not up yet and said why carries the reason, since when, and until when", () => {
    live.set("telegram:nouva", { status: "connecting", waiting: { reason: "Telegram asked this bot to wait 30 minutes before it connects.", since: 1_000, until: 1_801_000 } });
    expect(settings.gateways()[0]).toMatchObject({ status: "connecting", waiting: { reason: "Telegram asked this bot to wait 30 minutes before it connects.", since: 1_000, until: 1_801_000 } });
  });

  test("one that waits on nothing, is connected, or is not running yet carries none", () => {
    live.set("telegram:nouva", { status: "connecting", waiting: null });
    expect(settings.gateways()[0]).toMatchObject({ status: "connecting" });
    expect(settings.gateways()[0]).not.toHaveProperty("waiting");
    live.set("telegram:nouva", { status: "connected" });
    expect(settings.gateways()[0]).not.toHaveProperty("waiting");
    live.clear();
    expect(settings.gateways()[0]).toMatchObject({ status: null });
    expect(settings.gateways()[0]).not.toHaveProperty("waiting");
  });
});
