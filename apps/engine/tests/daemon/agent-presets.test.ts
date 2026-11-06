/**
 * What a new agent starts as, and changing an existing one's tools or which one is the default.
 *
 * A preset decides the first `[tools] enabled` and a few lines in `AGENTS.md`, then is forgotten: the
 * pack is ordinary, and the dashboard switches edit the same line afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { parseToml, readTextFile } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { PRESETS, presetOf, toolsFor } from "@/modules/setup/presets.ts";
import { FALLBACK_TOOLS, SetupService } from "@/modules/setup/service.ts";

let root: string;
let agentsDir: string;
let configPath: string;

beforeEach(() => {
  root = join(tmpdir(), `nouride-presets-${Math.floor(performance.now() * 1000)}`);
  agentsDir = join(root, "agents");
  configPath = join(root, "config.toml");
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function service() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = agentsDir;
  config.daemon.orchestrator = "";
  config.providers = {};
  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  const providers = new ProviderRegistry(config.providers, secrets);
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: config.llm.defaults, knownProviders: () => providers.names() });
  const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const setup = new SetupService({ config, configPath, dataDir: config.daemon.dataDir, agentsDir, secrets, providers, registry, userCount: () => 1, fetchImpl });
  await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: "sk-test-key-value", actor: "t" });
  return { config, registry, setup };
}

const input = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: id, systemPrompt: "Be brief.", model: "gpt-4o", actor: "t", ...extra });
const toolsOf = (registry: AgentRegistry, id: string) => registry.get(id)?.config.tools.enabled ?? [];

describe("presets", () => {
  test("five at most, Pilot first with everything, and Custom last with nothing picked for you", () => {
    expect(PRESETS.map((preset) => preset.label)).toEqual(["Pilot", "Researcher", "Assistant", "Developer", "Custom"]);
    expect(toolsFor("pilot", FALLBACK_TOOLS)).toEqual([...FALLBACK_TOOLS]);
    expect(toolsFor("custom", FALLBACK_TOOLS)).toEqual([]);
  });

  test("Researcher and Assistant have no shell and write no files; Developer has both", () => {
    for (const id of ["researcher", "assistant"] as const) {
      for (const tool of ["exec", "session", "write", "edit", "multi_edit"]) expect(toolsFor(id, FALLBACK_TOOLS)).not.toContain(tool);
    }
    expect(toolsFor("researcher", FALLBACK_TOOLS)).toEqual(expect.arrayContaining(["web_search", "web_fetch", "read"]));
    expect(toolsFor("assistant", FALLBACK_TOOLS)).toEqual(expect.arrayContaining(["memory_write", "nouride"]));
    expect(toolsFor("developer", FALLBACK_TOOLS)).toEqual(expect.arrayContaining(["exec", "write", "edit"]));
  });

  test("a preset names only tools the daemon has, in the daemon's order", () => {
    expect(toolsFor("researcher", ["web_fetch", "read"])).toEqual(["web_fetch", "read"]);
    expect(toolsFor("custom", ["read", "grep"], ["grep", "nonexistent"])).toEqual(["grep"]);
  });
});

describe("creating an agent from a preset", () => {
  test("every new agent asks only before what is risky, for everyone, rather than following each person", async () => {
    const { setup, registry } = await service();
    await setup.createAgent(input("nouva"));
    await setup.createAgent(input("scout", { preset: "researcher" }));
    for (const id of ["nouva", "scout"]) {
      expect(parseToml<{ agent: { approvals: string } }>(await readTextFile(join(agentsDir, id, "config.toml"))).agent.approvals).toBe("balanced");
      expect(registry.get(id)?.config.approvals).toBe("balanced");
    }
  });

  test("absent is Pilot: every tool, and its lines under How you work", async () => {
    const { setup, registry } = await service();
    await setup.createAgent(input("nouva"));
    expect(toolsOf(registry, "nouva")).toEqual(expect.arrayContaining(setup.availableTools()));
    expect(registry.get("nouva")?.config.tools.everyTool).toBe(true);
    expect(await readTextFile(join(agentsDir, "nouva", "AGENTS.md"))).toContain("## How you work\n\nYou can work across files, the terminal");
  });

  test("Researcher gets its tools and its lines, and nothing that writes", async () => {
    const { setup, registry } = await service();
    await setup.createAgent(input("scout", { preset: "researcher" }));
    expect(toolsOf(registry, "scout")).toEqual(toolsFor("researcher", setup.availableTools()));
    expect(toolsOf(registry, "scout")).not.toContain("exec");
    expect(await readTextFile(join(agentsDir, "scout", "AGENTS.md"))).toContain("You research.");
  });

  test("each preset has a starting SOUL, written when the form sends none, and the person's own kept (0.8.1)", async () => {
    // The owner: nobody should have to write a system prompt to make an agent.
    for (const preset of PRESETS) expect(preset.soul).toContain("Answer in the language you are spoken to in.");
    const { setup } = await service();
    await setup.createAgent(input("scout", { preset: "researcher", systemPrompt: "  " }));
    expect(await readTextFile(join(agentsDir, "scout", "SOUL.md"))).toBe(`# SOUL\n\n${presetOf("researcher").soul}\n`);
    await setup.createAgent(input("mine"));
    expect(await readTextFile(join(agentsDir, "mine", "SOUL.md"))).toBe("# SOUL\n\nBe brief.\n");
    // One that brings its own heading keeps it, rather than being read under `# SOUL` twice (0.8.6).
    await setup.createAgent(input("titled", { systemPrompt: "# SOUL.md - Titled\n\nBe brief." }));
    expect(await readTextFile(join(agentsDir, "titled", "SOUL.md"))).toBe("# SOUL.md - Titled\n\nBe brief.\n");
  });

  test("Custom gets exactly what was picked, and no lines of its own", async () => {
    const { setup, registry } = await service();
    await setup.createAgent(input("mine", { preset: "custom", tools: ["web_search", "read"] }));
    expect(toolsOf(registry, "mine")).toEqual(["read", "web_search"]);
    expect(await readTextFile(join(agentsDir, "mine", "AGENTS.md"))).not.toContain("## How you work");
  });
});

describe("after it exists", () => {
  test("its tools are switched in its config.toml and live at once; a tool the daemon lacks is refused", async () => {
    const { setup, registry } = await service();
    await setup.createAgent(input("nouva"));
    expect(await setup.setAgentTools({ agentId: "nouva", tools: ["web_search", "read"], actor: "t" })).toEqual({ ok: true });
    expect(toolsOf(registry, "nouva")).toEqual(["read", "web_search"]);
    expect(parseToml<{ tools: { enabled: string[] } }>(await readTextFile(join(agentsDir, "nouva", "config.toml"))).tools.enabled).toEqual(["read", "web_search"]);
    expect(await setup.setAgentTools({ agentId: "nouva", tools: ["teleport"], actor: "t" })).toMatchObject({ ok: false });
    expect(await setup.setAgentTools({ agentId: "ghost", tools: [], actor: "t" })).toMatchObject({ ok: false });
  });

  test("one agent is the default: written to the daemon's config and applied without a restart", async () => {
    const { setup, config } = await service();
    await setup.createAgent(input("nouva"));
    await setup.createAgent(input("nix"));
    expect(config.daemon.orchestrator).toBe("nouva");
    expect(await setup.setOrchestrator({ agentId: "nix", actor: "t" })).toEqual({ ok: true });
    expect(config.daemon.orchestrator).toBe("nix");
    expect(parseToml<{ daemon: { orchestrator: string } }>(await readTextFile(configPath)).daemon.orchestrator).toBe("nix");
    expect(await setup.setOrchestrator({ agentId: "ghost", actor: "t" })).toMatchObject({ ok: false });
  });
});
