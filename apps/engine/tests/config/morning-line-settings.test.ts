/**
 * A person's morning line in `[[people]]` (0.8.0): `morning = "07:00"` written beside the rest of their entry, taken
 * out for none, a time that is not one refused before anything is written — and at load, naming the entry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let settings: SettingsService;
const MIRA = `# People.\n[[people]]\nkey = "mira"\nname = "Mira"\nids = ["telegram:555"]\n`;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-morning-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, MIRA);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.people = [{ key: "mira", name: "Mira", ids: ["telegram:555"] }];
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => new Map(), retireGateway: async () => ({ stopped: true, loggedOut: true }) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(configPath, "utf8");

describe("a morning line", () => {
  test("written into their entry, the running config follows, and none takes it out again", async () => {
    expect(await settings.writePersonMorning("mira", { at: "07:30" }, "admin")).toEqual({ ok: true });
    expect(read()).toContain('morning = "07:30"');
    expect(read()).toStartWith("# People.");
    expect(config.people[0]?.morning).toBe("07:30");
    expect(await settings.writePersonMorning("mira", { at: null }, "admin")).toEqual({ ok: true });
    expect(read()).not.toContain("morning");
    expect(config.people[0]?.morning).toBeUndefined();
  });

  test("a time that is not one, or nobody by that key, is refused before anything is written", async () => {
    expect(await settings.writePersonMorning("mira", { at: "7am" }, "admin")).toMatchObject({ ok: false, field: "at", error: expect.stringContaining("HH:MM") });
    // Where it goes, refused, is that field of the row (0.8.23); nobody by that key is no field of it.
    expect(await settings.writePersonMorning("mira", { at: "07:00", to: "telegram:999" }, "admin")).toMatchObject({ ok: false, field: "to" });
    const ghost = await settings.writePersonMorning("ghost", { at: "07:00" }, "admin");
    expect(ghost).toMatchObject({ ok: false });
    expect(ghost).not.toHaveProperty("field");
    expect(read()).toBe(MIRA);
  });

  test("where it goes is written beside it, as morning_to, and read back", async () => {
    expect(await settings.writePersonMorning("mira", { at: "07:00", to: "telegram:555" }, "admin")).toEqual({ ok: true });
    expect(read()).toContain('morning_to = "telegram:555"');
    expect(config.people[0]?.morningTo).toBe("telegram:555");
    expect(await settings.writePersonMorning("mira", { at: null }, "admin")).toEqual({ ok: true });
    expect(read()).not.toContain("morning");
  });

  test("at load, morning_to that is not one of their chat accounts refuses to start, naming the entry", () => {
    expect(() => readConfigText(`${MIRA}morning = "07:00"\nmorning_to = "telegram:999"\n`, configPath)).toThrow('[[people]] #1 (mira) morning_to = "telegram:999" is not one of their accounts');
    const web = MIRA.replace('ids = ["telegram:555"]', 'ids = ["telegram:555", "web:usr_1"]');
    expect(() => readConfigText(`${web}morning_to = "web:usr_1"\n`, configPath)).toThrow("is a dashboard account, which no message reaches");
    expect(readConfigText(`${MIRA}morning = "07:00"\nmorning_to = "telegram:555"\n`, configPath).people[0]?.morningTo).toBe("telegram:555");
  });

  test("at load, a morning that is not a time of day refuses to start, naming the entry", () => {
    expect(() => readConfigText(`${MIRA}morning = "24:00"\n`, configPath)).toThrow('[[people]] #1 (mira) morning = "24:00" is a time of day, HH:MM');
    expect(readConfigText(`${MIRA}morning = "07:00"\n`, configPath).people[0]?.morning).toBe("07:00");
  });
});
