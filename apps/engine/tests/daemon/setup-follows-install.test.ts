/**
 * Whether an agent the setup makes follows the install's `[llm.defaults]` or says its own `[llm]`, read from the pack
 * and the config file it leaves, not from what loaded: a pack that pins a profile loads just as well, until the day
 * the install moves to another one.
 *
 * The rule is asked of each key on its own. It was asked of the provider alone: an install whose defaults named a
 * model and no provider had the provider written and the pack left empty, and the agent ran on the install's model
 * in place of the one it was made with. And what is written for an agent that then does not load is taken back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { parseToml, readTextFile, readTextFileIfExists } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SetupService } from "@/modules/setup/service.ts";

const KEY = "sk-live-do-not-commit-me";

let root: string;
let configPath: string;
let agentsDir: string;

beforeEach(() => {
  root = join(tmpdir(), `nouride-follows-${Math.floor(performance.now() * 1000)}`);
  agentsDir = join(root, "agents");
  configPath = join(root, "config.toml");
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A model listing for the probe, so nothing here touches the network. */
const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/** An install with two profiles, `default` and `second`, and nothing in its defaults. */
async function install() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = agentsDir;
  config.daemon.orchestrator = "";
  config.providers = {};
  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  const providers = new ProviderRegistry(config.providers, secrets);
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: config.llm.defaults, knownProviders: () => providers.names() });
  const setup = new SetupService({ config, configPath, dataDir: config.daemon.dataDir, agentsDir, secrets, providers, registry, userCount: () => 1, fetchImpl });
  await setup.saveProvider({ kind: "openai", baseUrl: "https://x.example/v1", apiKey: KEY, actor: "t" });
  await setup.saveProvider({ kind: "anthropic", name: "second", baseUrl: "https://y.example", apiKey: KEY, actor: "t" });
  /** What the install's file says its defaults are, as written: a key not written is not there. */
  const fileDefaults = async () => (parseToml<{ llm?: { defaults?: Record<string, unknown> } }>((await readTextFileIfExists(configPath)) ?? "").llm?.defaults ?? {}) as Record<string, unknown>;
  /** The install's defaults set as an admin would have: in the file, and in the running daemon with it. */
  const say = async (defaults: Record<string, string>) => {
    const saved = await editDaemonConfig(configPath, config, (text) => upsertTomlTable(text, "llm.defaults", defaults));
    if (!saved.ok) throw new Error(saved.error);
  };
  const make = (id: string, model: string, provider?: string) => setup.createAgent({ id, displayName: id, systemPrompt: "", model, actor: "t", ...(provider ? { provider } : {}) });
  /** The pack's own `[llm]` table as it was written, or null where it says none. */
  const packLlm = async (id: string) => (parseToml<{ llm?: Record<string, unknown> }>(await readTextFile(join(agentsDir, id, "config.toml"))).llm ?? null) as Record<string, unknown> | null;
  const loaded = (id: string) => ({ provider: registry.get(id)?.config.llm.provider, model: registry.get(id)?.config.llm.model });
  return { config, registry, setup, fileDefaults, say, make, packLlm, loaded };
}

describe("an agent made on an install with nothing in its defaults", () => {
  test("has its provider and model recorded as the install's, and says neither in its own pack", async () => {
    const h = await install();
    expect(await h.fileDefaults()).toEqual({});
    expect(await h.make("nouva", "gpt-4o-mini")).toMatchObject({ ok: true, provider: "default" });
    expect(await h.packLlm("nouva")).toBeNull();
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(h.config.llm.defaults).toMatchObject({ provider: "default", model: "gpt-4o-mini" });
    // And it runs on what it was made with.
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
  });

  test("the next one that agrees says nothing either, and the file is not written again", async () => {
    const h = await install();
    await h.make("nouva", "gpt-4o-mini");
    const file = await readTextFile(configPath);
    await h.make("nix", "gpt-4o-mini");
    expect(await h.packLlm("nix")).toBeNull();
    expect(h.loaded("nix")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    // The orchestrator was named at the first; nothing of the defaults moved at the second.
    expect((await h.fileDefaults())).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(await readTextFile(configPath)).toBe(file);
  });
});

describe("an agent that is not what the install's defaults say", () => {
  test("another model: its own pack says both keys, and the defaults stay as they were", async () => {
    const h = await install();
    await h.make("nouva", "gpt-4o-mini");
    await h.make("nix", "gpt-4o");
    expect(await h.packLlm("nix")).toEqual({ provider: "default", model: "gpt-4o" });
    expect(h.loaded("nix")).toEqual({ provider: "default", model: "gpt-4o" });
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o-mini" });
  });

  test("another provider: its own pack says both keys, and the defaults stay as they were", async () => {
    const h = await install();
    await h.make("nouva", "gpt-4o-mini");
    await h.make("nox", "gpt-4o-mini", "second");
    expect(await h.packLlm("nox")).toEqual({ provider: "second", model: "gpt-4o-mini" });
    expect(h.loaded("nox")).toEqual({ provider: "second", model: "gpt-4o-mini" });
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o-mini" });
  });
});

describe("an install whose defaults say one key and not the other", () => {
  test("a model and no provider, and the agent is made with another model: it runs on its own, said in its pack", async () => {
    // The provider alone was asked: it was written, the pack left empty, and the agent ran on the install's model.
    const h = await install();
    await h.say({ model: "gpt-4o" });
    await h.make("nouva", "gpt-4o-mini");
    expect(await h.packLlm("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    // Not the agent's to complete: the defaults name a model that is not its own.
    expect(await h.fileDefaults()).toEqual({ model: "gpt-4o" });
    expect(h.config.llm.defaults.provider).toBe("");
  });

  test("a model and no provider, and the agent is made with that model: the provider is filled in, and it follows", async () => {
    const h = await install();
    await h.say({ model: "gpt-4o" });
    await h.make("nouva", "gpt-4o");
    expect(await h.packLlm("nouva")).toBeNull();
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o" });
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o" });
  });

  test("a provider and no model, the agent's own provider: the model is filled in, and it follows", async () => {
    const h = await install();
    await h.say({ provider: "default" });
    await h.make("nouva", "gpt-4o-mini");
    expect(await h.packLlm("nouva")).toBeNull();
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
  });

  test("a provider and no model, and the agent is on another provider: its own pack says both, the defaults untouched", async () => {
    const h = await install();
    await h.say({ provider: "default" });
    await h.make("nox", "gpt-4o-mini", "second");
    expect(await h.packLlm("nox")).toEqual({ provider: "second", model: "gpt-4o-mini" });
    expect(await h.fileDefaults()).toEqual({ provider: "default" });
    expect(h.config.llm.defaults.model).toBe("");
  });
});

describe("a pack that does not load", () => {
  test("leaves the install's defaults as they were: the file to the byte, and the running daemon's with it", async () => {
    const h = await install();
    const file = await readTextFile(configPath);
    const reload = h.registry.reload.bind(h.registry);
    h.registry.reload = async () => {
      // Written by then: what the pack would have followed.
      expect(h.config.llm.defaults).toMatchObject({ provider: "default", model: "gpt-4o-mini" });
      throw new Error("the pack did not load");
    };
    try {
      expect(await h.make("nouva", "gpt-4o-mini")).toEqual({ ok: false, error: expect.stringContaining("did not load, so nothing was kept") });
    } finally {
      h.registry.reload = reload;
    }
    expect(await readTextFile(configPath)).toBe(file);
    expect(h.config.llm.defaults).toMatchObject({ provider: "", model: "" });
    expect(existsSync(join(agentsDir, "nouva"))).toBe(false);
    // And the same agent, made again once it loads, is made as the first of the install.
    expect(await h.make("nouva", "gpt-4o-mini")).toMatchObject({ ok: true });
    expect(await h.packLlm("nouva")).toBeNull();
    expect(await h.fileDefaults()).toEqual({ provider: "default", model: "gpt-4o-mini" });
  });

  test("where somebody else changed the file meanwhile, their change stays and only the keys written are emptied", async () => {
    const h = await install();
    const reload = h.registry.reload.bind(h.registry);
    h.registry.reload = async () => {
      const other = await editDaemonConfig(configPath, h.config, (text) => upsertTomlTable(text, "agents", { groups_require_mention: true }));
      expect(other.ok).toBe(true);
      throw new Error("the pack did not load");
    };
    try {
      expect((await h.make("nouva", "gpt-4o-mini")).ok).toBe(false);
    } finally {
      h.registry.reload = reload;
    }
    expect(parseToml<{ agents?: unknown }>(await readTextFile(configPath)).agents).toEqual({ groups_require_mention: true });
    expect(await h.fileDefaults()).toEqual({ provider: "", model: "" });
    expect(h.config.llm.defaults).toMatchObject({ provider: "", model: "" });
  });

  test("only what was written is taken back: a key the install already said stays", async () => {
    const h = await install();
    await h.say({ model: "gpt-4o" });
    const file = await readTextFile(configPath);
    const reload = h.registry.reload.bind(h.registry);
    h.registry.reload = async () => {
      throw new Error("the pack did not load");
    };
    try {
      expect((await h.make("nouva", "gpt-4o")).ok).toBe(false);
    } finally {
      h.registry.reload = reload;
    }
    expect(await readTextFile(configPath)).toBe(file);
    expect(await h.fileDefaults()).toEqual({ model: "gpt-4o" });
    expect(h.config.llm.defaults).toMatchObject({ provider: "", model: "gpt-4o" });
  });

  test("somebody else's change meanwhile, and a key the install already said: that key stays, the one written is emptied", async () => {
    const h = await install();
    await h.say({ model: "gpt-4o" });
    const reload = h.registry.reload.bind(h.registry);
    h.registry.reload = async () => {
      await editDaemonConfig(configPath, h.config, (text) => upsertTomlTable(text, "agents", { groups_require_mention: true }));
      throw new Error("the pack did not load");
    };
    try {
      expect((await h.make("nouva", "gpt-4o")).ok).toBe(false);
    } finally {
      h.registry.reload = reload;
    }
    expect(await h.fileDefaults()).toEqual({ provider: "", model: "gpt-4o" });
    expect(h.config.llm.defaults).toMatchObject({ provider: "", model: "gpt-4o" });
    expect(parseToml<{ agents?: unknown }>(await readTextFile(configPath)).agents).toEqual({ groups_require_mention: true });
  });

  test("an agent that pinned its own leaves nothing to take back", async () => {
    const h = await install();
    await h.make("nouva", "gpt-4o-mini");
    const file = await readTextFile(configPath);
    const reload = h.registry.reload.bind(h.registry);
    h.registry.reload = async () => {
      throw new Error("the pack did not load");
    };
    try {
      expect((await h.make("nix", "gpt-4o")).ok).toBe(false);
    } finally {
      h.registry.reload = reload;
    }
    expect(await readTextFile(configPath)).toBe(file);
  });
});

describe("an install whose running daemon does not hold what its file says", () => {
  test("the agent says its own in its pack: it is loaded against the running defaults, which would give it none", async () => {
    const h = await install();
    await h.say({ provider: "default", model: "gpt-4o-mini" });
    // The file says them; the daemon that runs lost them, as one whose file was edited under it has.
    h.config.llm.defaults.provider = "";
    h.config.llm.defaults.model = "";
    const file = await readTextFile(configPath);
    h.config.daemon.orchestrator = "someone";
    expect(await h.make("nouva", "gpt-4o-mini")).toMatchObject({ ok: true });
    expect(await h.packLlm("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(await readTextFile(configPath)).toBe(file);
  });
});

describe("an install whose running daemon holds one of the two its file says", () => {
  test.each([
    ["the provider, and not the model", { model: "" }],
    ["the model, and not the provider", { provider: "" }],
  ] as const)("%s: the agent says its own, since what it would follow is half there", async (_which, lost) => {
    const h = await install();
    await h.say({ provider: "default", model: "gpt-4o-mini" });
    Object.assign(h.config.llm.defaults, lost);
    const file = await readTextFile(configPath);
    h.config.daemon.orchestrator = "someone";
    expect(await h.make("nouva", "gpt-4o-mini")).toMatchObject({ ok: true });
    expect(await h.packLlm("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    expect(await readTextFile(configPath)).toBe(file);
  });
});

describe("an install whose file cannot be written", () => {
  test("the agent says its own in its pack: with nothing recorded to follow, it would not load", async () => {
    const h = await install();
    // An orchestrator already named: the one other write a first agent makes to that file is not this test's.
    h.config.daemon.orchestrator = "someone";
    // The config's place taken by a folder: nothing can be written there.
    rmSync(configPath, { force: true });
    mkdirSync(configPath);
    try {
      expect(await h.make("nouva", "gpt-4o-mini")).toMatchObject({ ok: true });
      expect(await h.packLlm("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
      expect(h.loaded("nouva")).toEqual({ provider: "default", model: "gpt-4o-mini" });
    } finally {
      rmSync(configPath, { recursive: true, force: true });
    }
  });
});
