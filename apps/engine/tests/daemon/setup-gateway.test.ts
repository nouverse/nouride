/**
 * "Use Nougate LLM Gateway" — setup without a typed key, on a build that hosts the gateway.
 *
 * The person signs in to an account through the gateway; the daemon does the rest: mints its own key,
 * stores it the way a typed one is stored (secret store, never config), writes the profile, and hands
 * the agent step the models those accounts can serve. Each of those is pinned here, with the gateway
 * replaced by a stand-in so nothing touches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { readTextFileIfExists } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { GATEWAY_PROFILE, SetupService } from "@/modules/setup/service.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

let root: string;
let dataDir: string;
let agentsDir: string;
let configPath: string;

function fakeGateway(models: string[]) {
  const asked: Array<string | null | undefined> = [];
  let minted = 0;
  return {
    asked,
    minted: () => minted,
    gateway: {
      url: "http://127.0.0.1:18256",
      connectedModels: () => models,
      ensureHostKey: async (_name: string, current?: string | null) => {
        asked.push(current);
        if (current) return { key: current, minted: false };
        minted += 1;
        return { key: `sk-nou-minted-${minted}`, minted: true };
      },
    },
  };
}

/** A fetch that fails the test if anything reaches for the network. */
const noNetwork = (async () => {
  throw new Error("the network was used");
}) as unknown as typeof fetch;

async function service(gateway?: ReturnType<typeof fakeGateway>["gateway"] | (() => ReturnType<typeof fakeGateway>["gateway"] | null)) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dataDir;
  config.daemon.agentsDir = agentsDir;
  config.providers = {};
  const secrets = await SecretStore.open(dataDir, {});
  const providers = new ProviderRegistry(config.providers, secrets);
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: config.llm.defaults, knownProviders: () => providers.names() });
  const setup = new SetupService({
    config, configPath, dataDir, agentsDir, secrets, providers, registry,
    userCount: () => 1,
    fetchImpl: noNetwork,
    ...(gateway ? { bundledGateway: typeof gateway === "function" ? gateway : () => gateway } : {}),
  });
  return { setup, secrets, config };
}

beforeEach(() => {
  root = join(tmpdir(), `nouride-setup-gateway-${Math.floor(performance.now() * 1000)}`);
  dataDir = join(root, "data");
  agentsDir = join(root, "agents");
  configPath = join(root, "config.toml");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Use Nougate LLM Gateway", () => {
  test("a build without the gateway says so", async () => {
    const { setup } = await service();
    expect(await setup.useBundledGateway({ actor: "owner" })).toEqual({ ok: false, error: "This build has no LLM gateway running." });
  });

  test("a gateway turned on after the wizard opened is the one it connects to", async () => {
    // Off at boot, on from the wizard's "Use Nougate": the service was built before it ran, and asks for it at each use.
    const fake = fakeGateway(["codex:gpt-5.1"]);
    let running: typeof fake.gateway | null = null;
    const { setup } = await service(() => running);
    expect(await setup.useBundledGateway({ actor: "owner" })).toEqual({ ok: false, error: "This build has no LLM gateway running." });
    running = fake.gateway;
    expect(await setup.useBundledGateway({ actor: "owner" })).toEqual({ ok: true, models: ["codex:gpt-5.1"] });
  });

  test("refused until an account is signed in, and nothing is written", async () => {
    // Saving now would offer the agent step models no account can serve.
    const fake = fakeGateway([]);
    const { setup, secrets } = await service(fake.gateway);
    const result = await setup.useBundledGateway({ actor: "owner" });
    expect(result.ok).toBe(false);
    expect(fake.minted()).toBe(0);
    expect(await readTextFileIfExists(configPath)).toBeNull();
    expect(secrets.resolve(`${GATEWAY_PROFILE}_api_key`)).toBeUndefined();
    expect(setup.state().hasProvider).toBe(false);
  });

  test("the key is minted by the daemon, stored as a secret, and named — never written — in config", async () => {
    const fake = fakeGateway(["codex:gpt-5.1", "codex:gpt-5.1-mini"]);
    const { setup, secrets } = await service(fake.gateway);
    const result = await setup.useBundledGateway({ actor: "owner" });

    expect(result).toEqual({ ok: true, models: ["codex:gpt-5.1", "codex:gpt-5.1-mini"] });
    // Named as the Models page names a profile's key: one writer for both.
    expect(secrets.resolve("nougate_api_key")).toBe("sk-nou-minted-1");

    const config = (await readTextFileIfExists(configPath)) ?? "";
    expect(config).toContain("[providers.nougate]");
    expect(config).toContain('base_url = "http://127.0.0.1:18256/openai/v1"');
    expect(config).toContain('api_key = "nougate_api_key"');
    expect(config).not.toContain("sk-nou-");
    expect(setup.state().hasProvider).toBe(true);
  });

  test("a profile made by hand keeps the secret it names, and that key is offered back first", async () => {
    // The wizard used to point it at `nougate_provider` and leave the operator's own key unreferenced in the store.
    const fake = fakeGateway(["copilot:gpt-4.1"]);
    const { setup, secrets, config } = await service(fake.gateway);
    await secrets.set("my_gate_key", "sk-own-key");
    config.providers.nougate = { kind: "openai", baseUrl: "http://127.0.0.1:18256/openai/v1", apiKeySecret: "my_gate_key" };
    writeFileSync(configPath, '[providers.nougate]\nkind = "openai"\nbase_url = "http://127.0.0.1:18256/openai/v1"\napi_key = "my_gate_key"\n');

    await setup.useBundledGateway({ actor: "owner" });
    expect(fake.asked).toEqual(["sk-own-key"]);
    expect((await readTextFileIfExists(configPath)) ?? "").toContain('api_key = "my_gate_key"');
    expect(secrets.inventory().map((entry) => entry.name)).toEqual(["my_gate_key"]);
  });

  test("pressing it again reuses the stored key rather than minting another", async () => {
    const fake = fakeGateway(["copilot:gpt-4.1"]);
    const { setup } = await service(fake.gateway);
    await setup.useBundledGateway({ actor: "owner" });
    await setup.useBundledGateway({ actor: "owner" });
    expect(fake.asked).toEqual([null, "sk-nou-minted-1"]);
    expect(fake.minted()).toBe(1);
  });

  test("the agent step lists what the accounts can serve, not the gateway's whole catalogue", async () => {
    // `/openai/v1/models` lists every provider, signed in or not; the probe is not used at all here
    // (`noNetwork` would fail the test), the gateway is asked instead.
    const fake = fakeGateway(["claudecode:claude-sonnet-4-5"]);
    const { setup } = await service(fake.gateway);
    await setup.useBundledGateway({ actor: "owner" });
    expect(await setup.listModels()).toEqual({ ok: true, models: ["claudecode:claude-sonnet-4-5"] });
  });

  test("a profile pointing somewhere else is probed, not answered from the gateway's accounts", async () => {
    // The shortcut belongs to the gateway's own URL; another provider's models are its own.
    const fake = fakeGateway(["claudecode:claude-sonnet-4-5"]);
    const { setup, secrets, config } = await service(fake.gateway);
    await secrets.set("elsewhere_api_key", "sk-elsewhere");
    config.providers.elsewhere = { kind: "openai", baseUrl: "https://elsewhere.example/v1", apiKeySecret: "elsewhere_api_key" };
    // `noNetwork` throws, so a probe is an error; the gateway's list would be a success.
    const result = await setup.listModels();
    expect(result.ok).toBe(false);
  });
});
