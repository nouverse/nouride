/**
 * The one way a config file is written (`modules/config/config-file.ts`): under one lock, checked before it lands,
 * the previous text kept — and for a pack, reloaded and put back when it no longer loads.
 *
 * Each test is a failure the 0.7.7 audit reproduced: concurrent saves losing one of them in the file, a save the
 * next boot refuses answering ok, a pack that no longer loads kept on disk behind an error toast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig, Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { editDaemonConfig, editPackFile } from "@/modules/config/config-file.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { withFileLock } from "@/commons/file-lock.ts";
import { parseAgentConfig, type RawAgentConfig } from "@nouride/persona";
import { sleep } from "../wait.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let settings: SettingsService;

const FILE = `# Nouride configuration — this comment survives every save.

[daemon]
name = "nouride"
`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-config-file-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, FILE);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
  } as unknown as ConstructorParameters<typeof SettingsService>[0]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => readFileSync(configPath, "utf8");
const parsed = () => parseToml<Record<string, Record<string, unknown>>>(file());

describe("saves at once", () => {
  test("every one lands in the file, as in memory — none is lost between another's read and write", async () => {
    // Twenty trials of twenty lost one of these before: each read the file, and the later write erased the earlier.
    const results = await Promise.all([
      settings.setMentionsEnabled({ enabled: false, actor: "a" }),
      settings.setDailyCostCap({ usd: 7, actor: "b" }),
      settings.setRetentionDays({ scope: "sessions", days: 30, actor: "c" }),
      settings.setAccessMode({ mode: "allowlist", actor: "d" }),
      settings.savePerson({ person: { name: "Ann", ids: ["telegram:111"] }, actor: "e" }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const toml = parsed();
    expect(toml.agents?.mentions_enabled).toBe(false);
    expect((toml.llm as { limits?: Record<string, unknown> })?.limits?.max_daily_cost_usd).toBe(7);
    expect((toml.security as { access?: Record<string, unknown> })?.access?.mode).toBe("allowlist");
    expect((toml.people as unknown as Person[])?.map((person) => person.name)).toEqual(["Ann"]);
    expect(file()).toContain("this comment survives every save");
  });

  test("one pack's settings at once all land too", async () => {
    const pack = join(dir, "agents", "nouva");
    mkdirSync(pack, { recursive: true });
    const agentConfigPath = join(pack, "config.toml");
    writeFileSync(agentConfigPath, '[agent]\nname = "Nouva"\n');
    const base = { agentConfigPath, reload: async () => {}, actor: "t", agentId: "nouva" };
    config.providers.local = { kind: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKeySecret: "local_key" };

    await Promise.all([
      settings.setAgentEnabled({ ...base, enabled: false }),
      settings.setAgentApprovals({ ...base, approvals: "balanced" }),
      settings.saveAgentModel({ ...base, provider: "local", model: "m-1" }),
      settings.saveAgentTurnSeconds({ ...base, seconds: 120 }),
    ]);
    const toml = parseToml<Record<string, Record<string, unknown>>>(readFileSync(agentConfigPath, "utf8"));
    expect(toml.agent).toMatchObject({ enabled: false, approvals: "balanced" });
    expect(toml.llm).toMatchObject({ provider: "local", model: "m-1", max_turn_seconds: 120 });
  });
});

describe("an agent's fallbacks (SMART_AUTOMATION §3.1)", () => {
  test("are written as pairs in order, refused when one is its own model or no profile — the file put back — and removed", async () => {
    const pack = join(dir, "agents", "nouva");
    mkdirSync(pack, { recursive: true });
    const agentConfigPath = join(pack, "config.toml");
    writeFileSync(agentConfigPath, '[llm]\nprovider = "anthropic"\nmodel = "m-1"\n');
    // As the registry reloads a pack: its own checks, and one that does not load is an error.
    const reload = async () =>
      parseAgentConfig("nouva", parseToml(readFileSync(agentConfigPath, "utf8")) as RawAgentConfig, { defaults: config.llm.defaults, knownProviders: ["anthropic", "openrouter"] });
    const base = { agentConfigPath, reload, actor: "t", agentId: "nouva" };
    const llm = () => parseToml<{ llm: Record<string, unknown> }>(readFileSync(agentConfigPath, "utf8")).llm;

    expect(await settings.saveAgentFallbacks({ ...base, fallbacks: [{ provider: "anthropic", model: " m-2 " }, { provider: "openrouter", model: "x/y" }] })).toMatchObject({ ok: true });
    expect(llm().fallbacks).toEqual([{ provider: "anthropic", model: "m-2" }, { provider: "openrouter", model: "x/y" }]);

    const before = readFileSync(agentConfigPath, "utf8");
    expect(await settings.saveAgentFallbacks({ ...base, fallbacks: [{ provider: "anthropic", model: "m-1" }] })).toMatchObject({ ok: false, error: expect.stringContaining("own model") });
    expect(await settings.saveAgentFallbacks({ ...base, fallbacks: [{ provider: "openroute", model: "x" }] })).toMatchObject({ ok: false, error: expect.stringContaining("not a configured profile") });
    expect(readFileSync(agentConfigPath, "utf8")).toBe(before);
    expect(await settings.saveAgentFallbacks({ ...base, fallbacks: [{ provider: "anthropic", model: "  " }] })).toMatchObject({ ok: false });

    expect(await settings.saveAgentFallbacks({ ...base, fallbacks: [] })).toMatchObject({ ok: true });
    expect(llm()).not.toHaveProperty("fallbacks");
    expect(llm()).toMatchObject({ provider: "anthropic", model: "m-1" });
  });
});

describe("what the next boot would refuse", () => {
  test("is refused, the file left as it was, and the running copy too", async () => {
    // Every check of the setting itself passes — no agent uses the profile — but semantic search still names it, and
    // the loader refuses a [memory.semantic] provider that is not a profile. Only the file's own check sees that.
    const named = `${FILE}\n[providers.ollama]\nkind = "openai"\nbase_url = "http://127.0.0.1:11434/v1"\napi_key = "ollama_key"\n\n[memory.semantic]\nenabled = true\nprovider = "ollama"\nmodel = "bge-m3"\n`;
    writeFileSync(configPath, named);
    config.providers.ollama = { kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKeySecret: "ollama_key" };
    const result = await settings.removeProvider("ollama", "admin", () => []);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("would not load") });
    expect(file()).toBe(named);
    expect(config.providers.ollama).toBeDefined();
  });

  test("an editor that throws is a refusal, not a 500, and nothing is written", async () => {
    const saved = await editDaemonConfig(configPath, config, () => {
      throw new Error("this editor cannot change that line");
    });
    expect(saved).toEqual({ ok: false, error: "this editor cannot change that line" });
    expect(file()).toBe(FILE);
  });

  test("what was there is kept as .bak.1 when a save lands", async () => {
    await settings.setMentionsEnabled({ enabled: false, actor: "a" });
    expect(readFileSync(`${configPath}.bak.1`, "utf8")).toBe(FILE);
  });
});

describe("a pack", () => {
  test("that no longer loads is put back byte for byte, and its agent reloaded on what loads", async () => {
    const path = join(dir, "config.toml.pack");
    writeFileSync(path, '[agent]\nname = "Nouva"\n');
    const before = readFileSync(path, "utf8");
    let reloads = 0;
    const saved = await editPackFile({
      path,
      edit: (text) => `${text}[llm]\nprovider = "nowhere"\n`,
      // The registry refuses what it cannot load, as it does a profile nobody defined.
      reload: async () => {
        reloads += 1;
        if (readFileSync(path, "utf8").includes("nowhere")) throw new Error('no provider profile "nowhere"');
      },
    });
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining("no longer loads") });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(reloads).toBe(2);
  });

  test("a .toml that would not parse is refused before anything is written or reloaded", async () => {
    const path = join(dir, "skills.toml");
    let reloaded = false;
    const saved = await editPackFile({ path, edit: () => "[skills\n", reload: async () => void (reloaded = true) });
    expect(saved).toMatchObject({ ok: false });
    expect(readdirSync(dir)).not.toContain("skills.toml");
    expect(reloaded).toBe(false);
  });
});

describe("the lock", () => {
  test("is one lock for one file, however its path is spelled", async () => {
    // The file editor reached a pack through its real path and the routes through the agent's directory; with a
    // symlink between them, they were two locks and serialized nothing against each other.
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    const counter = join(dir, "real", "n");
    writeFileSync(counter, "0");
    const bump = (path: string) =>
      withFileLock(path, async () => {
        const n = Number(readFileSync(counter, "utf8"));
        await sleep(20);
        writeFileSync(counter, String(n + 1));
      });
    await Promise.all([bump(join(dir, "real", "n")), bump(join(dir, "linked", "n"))]);
    expect(readFileSync(counter, "utf8")).toBe("2");
  });
});
