/**
 * Saving to the MCP library and switching it per agent (0.7.19).
 *
 * A typed credential goes to the secret store under a name of its own and only that name reaches a file — the library's
 * under `mcp-lib-<server>`, an agent's own under `mcp-<agent>-<server>`. A secret named from the CLI must exist; a
 * variable kept keeps what it named; a refused save takes back what it stored; a switch reaches only that agent, and
 * a save or removal reloads exactly the agents that use the server — so none of it asks for a restart.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { readAgentMcp } from "@nouride/persona";
import type { AgentMcpChoice, GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import type { McpPacks } from "@/modules/config/settings/mcp.ts";

let dir: string;
let agentsDir: string;
let secrets: SecretStore;
let settings: SettingsService;
let failReload = false;
let reloaded: string[];
let packs: McpPacks;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-mcp-lib-${Math.floor(performance.now() * 1000)}`);
  agentsDir = join(dir, "agents");
  for (const id of ["nouva", "nox"]) mkdirSync(join(agentsDir, id), { recursive: true });
  writeFileSync(join(dir, "config.toml"), "[daemon]\n");
  const config: GlobalConfig = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  secrets = await SecretStore.open(dir, {});
  failReload = false;
  reloaded = [];
  // What a registry answers: each pack's choices as its mcp.toml says them now.
  const choices = new Map<string, Record<string, AgentMcpChoice>>();
  packs = {
    agentsDir,
    agents: () => ["nouva", "nox"].map((id) => ({ id, dir: join(agentsDir, id), mcp: choices.get(id) ?? {} })),
    reload: async (id) => {
      if (failReload) throw new Error("the pack did not load");
      reloaded.push(id);
      choices.set(id, await readAgentMcp(join(agentsDir, id), id));
    },
  };
  settings = new SettingsService({
    config,
    configPath: join(dir, "config.toml"),
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
    retireGateway: async () => ({ stopped: true, loggedOut: true }),
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const gh = { name: "gh", transport: "stdio" as const, command: "npx" };
const save = (envSecrets?: Record<string, { value?: string; secret?: string }>, enable?: string[]) =>
  settings.saveLibraryServer({ packs, actor: "test", server: gh, ...(envSecrets ? { envSecrets } : {}), ...(enable ? { enable } : {}) });
const library = () => readFileSync(join(agentsDir, "mcp.toml"), "utf8");
const choicesOf = (id: string) => {
  const path = join(agentsDir, id, "mcp.toml");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

describe("the library's credential", () => {
  test("a typed value goes to the store under the library's name, and only the name reaches the file", async () => {
    expect(await save({ GITHUB_TOKEN: { value: "ghp_the-real-token-value" } })).toEqual({ ok: true, restartRequired: false, on: [] });
    expect(library()).toContain('env_secrets = { GITHUB_TOKEN = "mcp-lib-gh-github_token" }');
    expect(library()).not.toContain("ghp_the-real-token-value");
    expect(secrets.resolve("mcp-lib-gh-github_token")).toBe("ghp_the-real-token-value");
  });

  test("a secret named from the CLI must be in the store, or nothing is written", async () => {
    expect(await save({ GITHUB_TOKEN: { secret: "github_token" } })).toMatchObject({ ok: false, error: expect.stringContaining('"github_token", which is not set') });
    expect(existsSync(join(agentsDir, "mcp.toml"))).toBe(false);
    await secrets.set("github_token", "ghp_already-stored");
    expect(await save({ GITHUB_TOKEN: { secret: "github_token" } })).toMatchObject({ ok: true });
    expect(library()).toContain('env_secrets = { GITHUB_TOKEN = "github_token" }');
  });

  test("a variable kept as it is keeps the secret it named; one with nothing to keep is refused", async () => {
    await secrets.set("github_token", "ghp_already-stored");
    await save({ GITHUB_TOKEN: { secret: "github_token" } });
    expect(await save({ GITHUB_TOKEN: {} })).toMatchObject({ ok: true });
    expect(library()).toContain('env_secrets = { GITHUB_TOKEN = "github_token" }');
    expect(await save({ OTHER: {} })).toMatchObject({ ok: false, error: "OTHER has no value: give it one, or take it off" });
  });

  test("a refused save takes back the values it stored", async () => {
    await save(undefined, ["nouva"]);
    failReload = true;
    expect(await save({ GITHUB_TOKEN: { value: "ghp_should-not-stay" } })).toMatchObject({ ok: false });
    expect(secrets.resolve("mcp-lib-gh-github_token")).toBeUndefined();
  });

  test("a server the loader would refuse is never written", async () => {
    expect(await settings.saveLibraryServer({ packs, actor: "test", server: { name: "x", transport: "stdio" } })).toMatchObject({ ok: false, error: "a stdio server needs a command" });
    expect(await settings.saveLibraryServer({ packs, actor: "test", server: gh, enable: ["ghost"] })).toMatchObject({ ok: false, error: 'no agent "ghost"' });
    expect(existsSync(join(agentsDir, "mcp.toml"))).toBe(false);
  });
});

describe("one agent's switch", () => {
  test("a save switched on for the agents picked, and reloads only them — later saves reload only those using it", async () => {
    expect(await save(undefined, ["nouva"])).toEqual({ ok: true, restartRequired: false, on: ["nouva"] });
    expect(choicesOf("nouva")).toContain("[servers.gh]\non = true");
    expect(choicesOf("nox")).toBe("");
    reloaded = [];
    // A change names who still uses it, though none was picked this time — so it is not said to be on for nobody.
    expect(await settings.saveLibraryServer({ packs, actor: "test", server: { ...gh, args: ["-y", "gh-mcp"] } })).toEqual({ ok: true, restartRequired: false, on: ["nouva"] });
    expect(reloaded).toEqual(["nouva"]);
  });

  test("its own credential, under its own name — the library's untouched; and back to the library's", async () => {
    await save({ GITHUB_TOKEN: { value: "ghp_library" } }, ["nouva", "nox"]);
    expect(await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", credential: { envSecrets: { GITHUB_TOKEN: { value: "ghp_nox" } } } })).toEqual({ ok: true, restartRequired: false });
    expect(choicesOf("nox")).toContain('GITHUB_TOKEN = "mcp-nox-gh-github_token"');
    expect(secrets.resolve("mcp-nox-gh-github_token")).toBe("ghp_nox");
    expect(secrets.resolve("mcp-lib-gh-github_token")).toBe("ghp_library");
    expect(choicesOf("nouva")).not.toContain("GITHUB_TOKEN");

    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", credential: "library" });
    expect(choicesOf("nox")).not.toContain("GITHUB_TOKEN");
    expect(choicesOf("nox")).toContain("on = true");
  });

  test("switched off keeps its own credential, so switching it back on needs nothing typed again", async () => {
    await save(undefined, ["nox"]);
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", credential: { envSecrets: { GITHUB_TOKEN: { value: "ghp_nox" } } } });
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", on: false });
    expect(choicesOf("nox")).toContain("on = false");
    expect(choicesOf("nox")).toContain("mcp-nox-gh-github_token");
  });

  test("a login of its own is for a remote server; a stdio one is told to bring variables", async () => {
    await save(undefined, ["nouva"]);
    expect(await settings.setAgentMcp({ packs, agentId: "nouva", actor: "test", name: "gh", credential: { login: true } })).toMatchObject({ ok: false, error: expect.stringContaining("no login") });
    await settings.saveLibraryServer({ packs, actor: "test", server: { name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp" } });
    expect(await settings.setAgentMcp({ packs, agentId: "nouva", actor: "test", name: "notion", on: true, credential: { login: true } })).toMatchObject({ ok: true });
    expect(choicesOf("nouva")).toContain('login = "own"');
  });

  test("its tools list (0.7.21): set, kept through a switch and a credential change, and back to all with null", async () => {
    await save(undefined, ["nox"]);
    expect(await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", tools: ["search_issues", "get_issue"] })).toEqual({ ok: true, restartRequired: false });
    expect(choicesOf("nox")).toContain('tools = ["search_issues", "get_issue"]');
    expect(reloaded).toContain("nox");
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", on: false });
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", on: true, credential: "library" });
    expect(choicesOf("nox")).toContain('tools = ["search_issues", "get_issue"]');
    expect(await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", tools: [" "] })).toMatchObject({ ok: false });
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", tools: null });
    expect(choicesOf("nox")).not.toMatch(/^tools =/m);
    expect(choicesOf("nouva")).not.toMatch(/^tools =/m);
  });

  test("a server not in the library cannot be switched on", async () => {
    expect(await settings.setAgentMcp({ packs, agentId: "nouva", actor: "test", name: "ghost", on: true })).toMatchObject({ ok: false, error: expect.stringContaining("add it there first") });
  });
});

describe("taking a server out of the library", () => {
  test("out of every agent that named it, and says who — so their logins can go too", async () => {
    await save(undefined, ["nouva"]);
    await settings.setAgentMcp({ packs, agentId: "nox", actor: "test", name: "gh", on: false });
    reloaded = [];
    expect(await settings.removeLibraryServer({ packs, actor: "test", name: "gh" })).toEqual({ ok: true, restartRequired: false, users: ["nouva", "nox"] });
    expect(library()).not.toContain("gh");
    expect(choicesOf("nouva")).not.toContain("[servers.gh]");
    expect(reloaded.sort()).toEqual(["nouva", "nox"]);
    expect(await settings.removeLibraryServer({ packs, actor: "test", name: "gh" })).toMatchObject({ ok: false });
  });
});
