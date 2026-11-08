/**
 * Making an external agent and changing its CLI settings from the dashboard (0.8.1), through the setup service and the
 * loader as they run: the pack is written with `[external]`, loads as an external agent on the install's default model,
 * and is never made the orchestrator; its settings are `[external]` keys the loader reads back, an emptied one is
 * removed, and one the loader refuses leaves the file as it was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { readTextFileIfExists } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { BUILT_IN_CLIS } from "@nouride/acp";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

let root = "";

beforeEach(() => {
  root = join(tmpdir(), `nouride-external-setup-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function service() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = join(root, "agents");
  config.daemon.orchestrator = "";
  config.providers = {};
  config.llm.defaults.model = "gpt-4o";
  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  const providers = new ProviderRegistry(config.providers, secrets);
  const registry = await AgentRegistry.create({
    agentsDir: config.daemon.agentsDir,
    llmDefaults: config.llm.defaults,
    knownProviders: () => providers.names(),
    knownClis: () => BUILT_IN_CLIS.map((row) => row.id),
  });
  const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const setup = new SetupService({ config, configPath: join(root, "config.toml"), dataDir: config.daemon.dataDir, agentsDir: config.daemon.agentsDir, secrets, providers, registry, userCount: () => 1, fetchImpl });
  await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: "sk-test-not-a-real-key", actor: "t" });
  return { config, registry, setup };
}

describe("an external agent from the dashboard", () => {
  test("is a pack with [external], on the install's default model, and never the orchestrator", async () => {
    const { config, registry, setup } = await service();
    expect(await setup.createAgent({ id: "coder", displayName: "Coder", systemPrompt: "", model: "", actor: "t", external: { cli: "claude-code", profile: "work" } })).toMatchObject({ ok: true, id: "coder" });
    expect(registry.get("coder")?.config.external).toEqual({ cli: "claude-code", profile: "work" });
    expect(registry.get("coder")?.config.llm.model).toBe("gpt-4o");
    expect(config.daemon.orchestrator).toBe("");
    expect(await readTextFileIfExists(join(root, "config.toml"))).not.toContain("orchestrator");
  });

  test("on an install with no default model, Nouride's own for it is the orchestrator's — the live box refused it (0.8.1)", async () => {
    // "A model is required": New Agent sends none for an external agent, and the live box has no default model.
    const { config, registry, setup } = await service();
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o-mini", actor: "t" });
    expect(config.daemon.orchestrator).toBe("nouva");
    config.llm.defaults.model = "";
    expect(await setup.createAgent({ id: "coder", displayName: "Coder", systemPrompt: "", model: "", actor: "t", external: { cli: "codex" } })).toMatchObject({ ok: true, id: "coder" });
    expect(registry.get("coder")?.config.llm).toMatchObject({ provider: registry.get("nouva")!.config.llm.provider, model: "gpt-4o-mini" });
  });

  test("its settings are [external] keys the loader reads; emptied ones go; one it refuses changes nothing", async () => {
    const { registry, setup } = await service();
    await setup.createAgent({ id: "coder", displayName: "Coder", systemPrompt: "", model: "", actor: "t", external: { cli: "codex" } });
    expect(await setup.setExternal({ agentId: "coder", settings: { permissions: "all", model: "gpt-5" }, actor: "t" })).toEqual({ ok: true });
    expect(registry.get("coder")?.config.external).toEqual({ cli: "codex", permissions: "all", model: "gpt-5" });

    expect(await setup.setExternal({ agentId: "coder", settings: { model: "" }, actor: "t" })).toEqual({ ok: true });
    expect(registry.get("coder")?.config.external).toEqual({ cli: "codex", permissions: "all" });

    const before = await readTextFileIfExists(join(root, "agents", "coder", "config.toml"));
    const refused = await setup.setExternal({ agentId: "coder", settings: { profile: "Not A Profile" }, actor: "t" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Saved nothing") });
    expect(await readTextFileIfExists(join(root, "agents", "coder", "config.toml"))).toBe(before);
  });

  test("an agent that is not external has no CLI settings to change", async () => {
    const { setup } = await service();
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    expect(await setup.setExternal({ agentId: "nouva", settings: { model: "x" }, actor: "t" })).toEqual({ ok: false, error: "nouva is not an external agent" });
  });
});

describe("an agent that exists, answered by a coding CLI or by its model again (0.8.1)", () => {
  test("is given [external] through the loader, and has it taken out again, its pack's other keys kept", async () => {
    const { registry, setup } = await service();
    // The first agent made is the orchestrator, which is never made external: Nouva first, then Nix.
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    expect(await setup.createAgent({ id: "nix", displayName: "Nix", systemPrompt: "Write code.", model: "gpt-4o", actor: "t" })).toMatchObject({ ok: true });
    expect(registry.get("nix")?.config.external).toBeUndefined();
    expect(await setup.setAnsweredBy({ agentId: "nix", cli: "claude-code", profile: "work", actor: "t" })).toEqual({ ok: true });
    expect(registry.get("nix")?.config.external).toEqual({ cli: "claude-code", profile: "work" });
    expect(registry.get("nix")?.config.displayName).toBe("Nix");
    expect(await setup.setAnsweredBy({ agentId: "nix", cli: null, actor: "t" })).toEqual({ ok: true });
    expect(registry.get("nix")?.config.external).toBeUndefined();
    expect(await readTextFileIfExists(join(root, "agents", "nix", "config.toml"))).not.toContain("[external]");
  });

  test("switched to another CLI, it is not asked for the model named for the one before — kept on the same one (0.8.1)", async () => {
    // The key was kept: an agent moved from Codex to Claude Code asked Claude Code for `gpt-5`.
    const { registry, setup } = await service();
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    await setup.createAgent({ id: "coder", displayName: "Coder", systemPrompt: "", model: "", actor: "t", external: { cli: "codex" } });
    expect(await setup.setExternal({ agentId: "coder", settings: { model: "gpt-5", permissions: "all" }, actor: "t" })).toEqual({ ok: true });
    expect(await setup.setAnsweredBy({ agentId: "coder", cli: "codex", profile: "work", actor: "t" })).toEqual({ ok: true });
    expect(registry.get("coder")?.config.external).toEqual({ cli: "codex", profile: "work", permissions: "all", model: "gpt-5" });
    expect(await setup.setAnsweredBy({ agentId: "coder", cli: "claude-code", actor: "t" })).toEqual({ ok: true });
    expect(registry.get("coder")?.config.external).toEqual({ cli: "claude-code", profile: "work", permissions: "all" });
  });

  test("a CLI the install does not know changes nothing, and the orchestrator is never made one", async () => {
    const { config, registry, setup } = await service();
    // Nouva first, so it is the orchestrator: made first, Nix was, and the refusal below was the orchestrator's, the
    // unknown CLI's never reached.
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    expect(await setup.createAgent({ id: "nix", displayName: "Nix", systemPrompt: "", model: "gpt-4o", actor: "t" })).toMatchObject({ ok: true });
    expect(config.daemon.orchestrator).toBe("nouva");
    const before = await readTextFileIfExists(join(root, "agents", "nix", "config.toml"));
    // Refused by the pack's own load: no one field of the page to name.
    const unknown = await setup.setAnsweredBy({ agentId: "nix", cli: "cursor", actor: "t" });
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown).not.toHaveProperty("field");
    expect(await readTextFileIfExists(join(root, "agents", "nix", "config.toml"))).toBe(before);
    config.daemon.orchestrator = "nix";
    // The choice itself, refused for the orchestrator, names its field (0.8.23).
    expect(await setup.setAnsweredBy({ agentId: "nix", cli: "claude-code", actor: "t" })).toMatchObject({ ok: false, field: "cli", error: expect.stringContaining("Make a Nouride agent the orchestrator") });
    expect(registry.get("nix")?.config.external).toBeUndefined();
  });
});

