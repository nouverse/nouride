/**
 * The model tiers as the dashboard sets them (`config/settings/tiers.ts`): the install's `small_model` / `high_model`
 * and each helper key's tier in `config.toml`, and one agent's own pair in its pack — written through the one checked
 * write, refused before anything is written when the value cannot load.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";

const START = `# Hand-written: every save keeps this line.

[providers.main]
kind = "openai"
base_url = "https://main.test/v1"
api_key = "main_key"

[llm.defaults]
provider = "main"
model = "m-default"

[memory]
pass_provider = "main"
pass_model = "m-pass"
`;

let dir: string;
let configPath: string;
let config: GlobalConfig;
let settings: SettingsService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-tiers-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, START);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.providers = { main: { kind: "openai", baseUrl: "https://main.test/v1", apiKeySecret: "main_key" } } as never;
  config.llm.defaults = { ...config.llm.defaults, provider: "main", model: "m-default" };
  config.memory = { ...config.memory, passProvider: "main", passModel: "m-pass" };
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => new Map(), retireGateway: async () => ({ stopped: true, loggedOut: true }) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => parseToml<Record<string, Record<string, unknown>>>(readFileSync(configPath, "utf8"));

describe("the install's tiers and each helper's", () => {
  test("are written where the loader reads them, and the running config follows — live", async () => {
    const saved = await settings.setModelTiers({ patch: { smallModel: "m-small", highModel: "m-high", summaryModel: "small", steerReplyModel: "small", imageModel: "high", learningModel: "small" }, actor: "t" });
    expect(saved).toEqual({ ok: true, restartRequired: false });
    const written = file();
    expect(written.llm).toMatchObject({ defaults: { small_model: "m-small", high_model: "m-high" }, context: { summary_model: "small" } });
    expect([written.queue?.steer_reply_model, written.media?.image_model, (written.skills?.learning as Record<string, unknown> | undefined)?.model]).toEqual(["small", "high", "small"]);
    expect(readFileSync(configPath, "utf8")).toStartWith("# Hand-written: every save keeps this line.");
    expect(config.llm.defaults).toMatchObject({ smallModel: "m-small", highModel: "m-high" });
    expect(settings.modelTiers().helpers).toMatchObject({ summaryModel: "small", imageModel: "high" });
  });

  test("a tier for the nightly pass takes its provider away — a tier is each agent's own, on its own provider", async () => {
    expect(await settings.setModelTiers({ patch: { passModel: "small" }, actor: "t" })).toMatchObject({ ok: true });
    expect(file().memory).toEqual({ pass_model: "small" });
    expect(config.memory).toMatchObject({ passProvider: "", passModel: "small" });
  });

  test("…and so does each agent's own; a model id keeps the provider it is on", async () => {
    expect(await settings.setModelTiers({ patch: { passModel: "m-pass-2" }, actor: "t" })).toMatchObject({ ok: true });
    expect(file().memory).toEqual({ pass_provider: "main", pass_model: "m-pass-2" });
    expect(await settings.setModelTiers({ patch: { passModel: "" }, actor: "t" })).toMatchObject({ ok: true });
    expect(file().memory ?? {}).toEqual({});
  });

  test("empty takes the key out: the tier follows `model` again", async () => {
    await settings.setModelTiers({ patch: { smallModel: "m-small" }, actor: "t" });
    await settings.setModelTiers({ patch: { smallModel: "" }, actor: "t" });
    expect(file().llm?.defaults).toEqual({ provider: "main", model: "m-default" });
  });

  test("refused before anything is written: a tier named as a model, a pass model with no provider, a key it does not know", async () => {
    const before = readFileSync(configPath, "utf8");
    expect(await settings.setModelTiers({ patch: { smallModel: "high" }, actor: "t" })).toEqual({ ok: false, error: "small_model names a model, not a tier" });
    await settings.setModelTiers({ patch: { passModel: "small" }, actor: "t" });
    const afterTier = readFileSync(configPath, "utf8");
    expect(await settings.setModelTiers({ patch: { passModel: "m-other" }, actor: "t" })).toMatchObject({ ok: false, error: expect.stringContaining("needs its provider") });
    expect(await settings.setModelTiers({ patch: { fallbackModel: "x" } as never, actor: "t" })).toEqual({ ok: false, error: 'unknown setting "fallbackModel"' });
    expect(readFileSync(configPath, "utf8")).toBe(afterTier);
    expect(before).not.toBe(afterTier);
  });
});

describe("one agent's own pair", () => {
  const pack = () => join(dir, "nox.toml");
  beforeEach(() => writeFileSync(pack(), '[llm]\nprovider = "main"\nmodel = "nox-model"\n'));
  const save = (tiers: { small?: string | null; high?: string | null }) =>
    settings.saveAgentTiers({ agentConfigPath: pack(), reload: async () => {}, tiers, actor: "t", agentId: "nox" });

  test("is written into its [llm], and null takes it out — inheriting the install's again", async () => {
    expect(await save({ small: "nox-small", high: "nox-high" })).toEqual({ ok: true, restartRequired: false });
    expect(parseToml<{ llm: Record<string, string> }>(readFileSync(pack(), "utf8")).llm).toEqual({ provider: "main", model: "nox-model", small_model: "nox-small", high_model: "nox-high" });
    expect(await save({ small: null })).toMatchObject({ ok: true });
    expect(parseToml<{ llm: Record<string, string> }>(readFileSync(pack(), "utf8")).llm).toEqual({ provider: "main", model: "nox-model", high_model: "nox-high" });
  });

  test("a tier's name or nothing is refused, and the pack is left as it was", async () => {
    const before = readFileSync(pack(), "utf8");
    expect(await save({ high: "small" })).toEqual({ ok: false, error: "high_model names a model, not a tier" });
    expect(await save({ small: "  " })).toMatchObject({ ok: false });
    expect(readFileSync(pack(), "utf8")).toBe(before);
  });
});
