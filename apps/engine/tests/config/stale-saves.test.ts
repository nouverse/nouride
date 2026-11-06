/**
 * A save made against what somebody saw, when what they saw has changed since — the windows the 0.7.7 audit measured
 * in minutes rather than milliseconds: a tab left open on the config editor, the People dialog, an agent's notes
 * written meanwhile. Each is refused with a conflict or made against the file as it is, never written over the newer
 * change. And a save that is refused leaves the credential that works where it was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig, Person } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { FileService } from "@/modules/setup/files.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let secrets: SecretStore;
let settings: SettingsService;

const FILE = '# hand-written\n[daemon]\nname = "nouride"\n';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-stale-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, FILE);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
  } as unknown as ConstructorParameters<typeof SettingsService>[0]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const people = () => (parseToml<{ people?: Person[] }>(readFileSync(configPath, "utf8")).people ?? []);

describe("the raw config editor", () => {
  const files = () => new FileService({ agentsDir: dir, configPath, registry: {} as AgentRegistry } as never);

  test("a save made against text the file no longer holds is a conflict, and the file keeps the newer change", async () => {
    const opened = FILE;
    await settings.setMentionsEnabled({ enabled: false, actor: "card" });
    const result = await files().writeDaemonConfig(`${opened}# my edit\n`, "admin", opened);
    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(configPath, "utf8")).toContain("mentions_enabled = false");
  });

  test("against what is there, it saves", async () => {
    expect(await files().writeDaemonConfig(`${FILE}# my edit\n`, "admin", FILE)).toMatchObject({ ok: true });
  });
});

describe("[[people]]", () => {
  test("a list of accounts saved against one that changed since is a conflict, not the new account taken away", async () => {
    await settings.savePerson({ person: { key: "ann", name: "Ann", ids: ["telegram:1"] }, create: true });
    // Paired while the dialog was open.
    await settings.linkIdentity({ identity: "discord:2", target: { person: "ann" } });
    const result = await settings.savePerson({ person: { key: "ann", name: "Ann", ids: ["telegram:1"] }, expectedIds: ["telegram:1"] });
    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(people()[0]?.ids).toEqual(["telegram:1", "discord:2"]);
  });

  test("two accounts linked to one person at once are both theirs", async () => {
    await settings.savePerson({ person: { key: "ann", name: "Ann" }, create: true });
    await Promise.all([
      settings.linkIdentity({ identity: "telegram:1", target: { person: "ann" } }),
      settings.linkIdentity({ identity: "discord:2", target: { person: "ann" } }),
    ]);
    expect(new Set(people()[0]?.ids)).toEqual(new Set(["telegram:1", "discord:2"]));
  });

  test("a facts mode written while the person is renamed keeps the new name", async () => {
    await settings.savePerson({ person: { key: "ann", name: "Ann" }, create: true });
    await Promise.all([
      settings.savePerson({ person: { key: "ann", name: "Ann Bishop" } }),
      settings.setPersonFacts({ key: "ann", facts: "ask" }),
    ]);
    expect(people()[0]).toMatchObject({ name: "Ann Bishop", facts: "ask" });
    expect(config.people[0]).toMatchObject({ name: "Ann Bishop", facts: "ask" });
  });

  test("a recall written beside a facts mode keeps both, and null takes it out again", async () => {
    await settings.savePerson({ person: { key: "ann", name: "Ann" }, create: true });
    await Promise.all([settings.setPersonFacts({ key: "ann", facts: "ask" }), settings.setPersonRecall({ key: "ann", recall: false })]);
    expect(people()[0]).toMatchObject({ facts: "ask", recall: false });
    expect(config.people[0]).toMatchObject({ facts: "ask", recall: false });
    await settings.setPersonRecall({ key: "ann", recall: null });
    expect(people()[0]).not.toHaveProperty("recall");
    expect(config.people[0]?.recall).toBeUndefined();
    expect(people()[0]).toMatchObject({ facts: "ask" });
  });
});

describe("a refused save", () => {
  test("leaves the stored token as it was — the gateway it belongs to keeps connecting with it", async () => {
    await settings.saveGateway({ platform: "telegram", name: "bot", enabled: true, token: "OLD-TOKEN", actor: "t" });
    const result = await settings.saveGateway({ platform: "telegram", name: "bot", enabled: true, token: "NEW-TOKEN", groupContextMessages: 99_999, actor: "t" });
    expect(result.ok).toBe(false);
    expect(secrets.resolve("telegram-bot")).toBe("OLD-TOKEN");
  });

  test("a new WhatsApp connection refused leaves no session key behind", async () => {
    const result = await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, groupContextMessages: 99_999, actor: "t" });
    expect(result.ok).toBe(false);
    expect(secrets.inventory()).toEqual([]);
  });
});
