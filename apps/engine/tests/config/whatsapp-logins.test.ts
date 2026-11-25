/**
 * Each WhatsApp number's login is in a folder of its own, through the settings a dashboard or a command saves.
 *
 * A daemon holds a connection for each number. Removing one takes its login and no other's, and a second connection
 * is not saved onto the folder another keeps its login in: two sockets on one login write the same credentials, and
 * WhatsApp closes both. Where the folder defaults, and the loader's own refusal, are `config-memory.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";

let dir: string;
let configPath: string;
let secrets: SecretStore;
let settings: SettingsService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-whatsapp-logins-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "nouride"\n');
  const config: GlobalConfig = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
    retireGateway: async () => ({ stopped: true, loggedOut: true }),
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(configPath, "utf8");

test("removing one connection takes its login and no other's", async () => {
  await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, actor: "test" });
  await settings.saveGateway({ platform: "whatsapp", name: "shop", enabled: true, actor: "test" });
  const folder = (id: string) => settings.gateways().find((gateway) => gateway.id === id)!.sessionDir!;
  const [main, shop] = [folder("whatsapp:main"), folder("whatsapp:shop")];
  expect(main).not.toBe(shop);
  for (const login of [main, shop]) {
    mkdirSync(login, { recursive: true });
    writeFileSync(join(login, "creds.enc"), "encrypted-login-bytes");
  }
  expect(await settings.removeGateway("whatsapp:shop", "test")).toMatchObject({ ok: true });
  expect({ shop: existsSync(shop), main: existsSync(join(main, "creds.enc")) }).toEqual({ shop: false, main: true });
  expect(await secrets.resolve("whatsapp-main-key")).toBeDefined();
});

test("a second connection given the folder another keeps its login in is not saved", async () => {
  await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, sessionDir: "/var/lib/wa", actor: "test" });
  const before = read();
  const refused = await settings.saveGateway({ platform: "whatsapp", name: "shop", enabled: true, sessionDir: "/var/lib/wa", actor: "test" });
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("keep their login in one folder (/var/lib/wa)") });
  expect(read()).toBe(before);
});
