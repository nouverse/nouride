/**
 * An agent's look in Nouride Office from its Look tab (0.8.1), through the setup service and the loader as they run:
 * each part picked is a `[look]` key the loader reads back, a part emptied is removed (its own again, from the id), and
 * a word that is not one of the part's is refused before anything is written.
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
  root = join(tmpdir(), `nouride-look-setup-${Math.floor(performance.now() * 1000)}`);
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

describe("an agent's look", () => {
  test("each part picked is a [look] key the loader reads; an emptied one is removed", async () => {
    const { registry, setup } = await service();
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    expect(await setup.setLook({ agentId: "nouva", look: { fur: "ginger", outfitColor: "lime", hat: "beanie" }, actor: "t" })).toEqual({ ok: true });
    expect(registry.get("nouva")?.config.look).toEqual({ fur: "ginger", outfitColor: "lime", hat: "beanie" });
    expect(await readTextFileIfExists(join(root, "agents", "nouva", "config.toml"))).toContain('outfit_color = "lime"');
    expect(await setup.setLook({ agentId: "nouva", look: { hat: "", fur: "grey" }, actor: "t" })).toEqual({ ok: true });
    expect(registry.get("nouva")?.config.look).toEqual({ fur: "grey", outfitColor: "lime" });
  });

  test("a word that is not one of the part's is refused, and nothing is written", async () => {
    const { setup } = await service();
    await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "", model: "gpt-4o", actor: "t" });
    const before = await readTextFileIfExists(join(root, "agents", "nouva", "config.toml"));
    expect(await setup.setLook({ agentId: "nouva", look: { hat: "crown" }, actor: "t" })).toEqual({ ok: false, error: "hat must be one of none, beanie, cap, beret, headband, headphones, or empty for its own" });
    expect(await readTextFileIfExists(join(root, "agents", "nouva", "config.toml"))).toBe(before);
  });
});
