/**
 * A coding-CLI agent setting its own CLI's model through `agent_configure` (0.8.8, `tools/builtins/cli-model.ts`). Nox
 * asked for Opus and was refused: the model was a person's to set on its CLI tab. Now the tool sets the key that tab
 * writes, to a model the CLI offers on the agent's account and nothing else, and the person in the chat is told and the
 * audit log has it; `[llm]` stays the dashboard's. The next turn sets it in the session already open — shown against the
 * fake CLI, with a real registry reloading the pack.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import { AgentRegistry, privateWorkspace } from "@nouride/persona";
import { parseToml } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { externalModelsState, externalSessionsState } from "@/commons/daemon-state.ts";
import { stateRows } from "../helpers.ts";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { createAgentConfigureTool } from "@/modules/tools/builtins/harness.ts";
import type { CliModels } from "@/modules/tools/builtins/cli-model.ts";
import { stderrSaid } from "../external-agents/fixtures/stderr.ts";

let dir: string;
const services: ExternalAgents[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-cli-model-"));
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { agentId: "nox", senderId: "555", gatewayId: "telegram:nox", chatId: "555" } as ToolContext;
const LLM = { defaults: () => ({ provider: "local", model: "m-1" }), orchestrator: () => undefined };
const PACK = '[agent]\nname = "Nox"\n\n[llm]\nprovider = "local"\nmodel = "m-1"\n\n[external]\ncli = "claude-code"\nprofile = "work"\n';
const OFFERED: CliModels = { name: "Claude Code", offered: [{ value: "default", name: "Default", current: "Sonnet 5.5" }, { value: "opus", name: "Opus 5.5" }, { value: "haiku" }], runsOn: "Sonnet 5.5" };

function nox(models: CliModels = OFFERED, landed = true) {
  mkdirSync(join(dir, "nox"), { recursive: true });
  const path = join(dir, "nox", "config.toml");
  writeFileSync(path, PACK);
  const reloaded: string[] = [];
  const audited: { action: string; details?: Record<string, unknown> }[] = [];
  const told: { chat: string; text: string }[] = [];
  const registry = {
    get: () => ({ config: { id: "nox", displayName: "Nox", external: { cli: "claude-code", profile: "work" } } }),
    reload: async (id: string) => void reloaded.push(id),
  } as unknown as AgentRegistry;
  const tool = createAgentConfigureTool({
    registry,
    agentsDir: dir,
    providers: () => [{ name: "local", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", hasCredential: true }],
    llm: LLM,
    audit: { record: (entry: { action: string; details?: Record<string, unknown> }) => void audited.push(entry) } as never,
    cliModels: (agentId, cli) => (agentId === "nox" && cli === "claude-code" ? models : { name: "?", offered: [], runsOn: null }),
    tell: async (at, text) => {
      told.push({ chat: `${at.gatewayId}:${at.chatId}`, text });
      return landed;
    },
  });
  const toml = () => parseToml<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8"));
  return { tool, path, toml, reloaded, audited, told };
}

describe("agent_configure on a coding CLI's agent: `model` is its CLI's (0.8.8)", () => {
  test("one its CLI offers on its account is written where the CLI tab writes it, [llm] untouched — reloaded, audited, and the chat told", async () => {
    const { tool, toml, reloaded, audited, told } = nox();
    const result = await tool.execute({ model: "opus" }, ctx);
    expect(result.isError).toBe(false);
    expect(toml().external).toEqual({ cli: "claude-code", profile: "work", model: "opus" });
    expect(toml().llm).toEqual({ provider: "local", model: "m-1" });
    expect(reloaded).toEqual(["nox"]);
    expect(audited).toEqual([{ action: "agent_configured", agentId: "nox", actor: "555", details: { cliModel: "opus", from: "Sonnet 5.5", account: "work", cli: "claude-code", effort: undefined } } as never]);
    expect(told).toEqual([{ chat: "telegram:nox:555", text: 'Nox changed its Claude Code model from Sonnet 5.5 to opus, on the account "work". Every agent on that account shares its limits.' }]);
    expect(result.content).toContain('Your Claude Code model is now opus (it was Sonnet 5.5), on the account "work"');
    expect(result.content).toContain("Your [llm] is unchanged.");
    expect(result.content).toContain("The person here was told.");
  });

  test("one it does not offer on the account is refused with the choices: nothing written, nobody told", async () => {
    const { tool, path, reloaded, audited, told } = nox();
    const result = await tool.execute({ model: "claude-opus-5-5" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('"claude-opus-5-5" is not a model Claude Code offers on the account "work". It offers: default (Default), opus (Opus 5.5), haiku.');
    expect(readFileSync(path, "utf8")).toBe(PACK);
    expect([reloaded, audited, told]).toEqual([[], [], []]);
  });

  test("before its CLI has said what it offers, nothing is taken on trust", async () => {
    const { tool, path } = nox({ name: "Claude Code", offered: [], runsOn: null });
    const result = await tool.execute({ model: "opus" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Claude Code has not said which models it offers on the account "work"');
    expect(readFileSync(path, "utf8")).toBe(PACK);
  });

  test("its provider stays the dashboard's; with effort, both are written in the one change", async () => {
    const { tool, path, toml } = nox();
    const provider = await tool.execute({ provider: "local", model: "opus" }, ctx);
    expect(provider.isError).toBe(true);
    expect(provider.content).toContain("Your provider is Nouride's own");
    expect(readFileSync(path, "utf8")).toBe(PACK);
    expect((await tool.execute({ model: "haiku", effort: "high" }, ctx)).isError).toBe(false);
    expect(toml().external?.model).toBe("haiku");
    expect(toml().llm).toEqual({ provider: "local", model: "m-1", effort: "high" });
  });

  test("a chat the line did not land in is said, and the change stands", async () => {
    const { tool, toml } = nox(OFFERED, false);
    const result = await tool.execute({ model: "opus" }, ctx);
    expect(result.content).toContain("This chat could not be told; the audit log has it.");
    expect(toml().external?.model).toBe("opus");
  });
});

describe("set from a turn, it reaches the session already open, and outlives a restart (0.8.8)", () => {
  const FAKE = join(import.meta.dir, "../external-agents/fixtures/fake-cli.ts");
  const row: CliRow = {
    id: "fake",
    name: "Fake CLI",
    command: process.execPath,
    args: [FAKE],
    install: "it is a test",
    versionArgs: ["--version"],
    profileEnv: "FAKE_HOME",
    env: { FAKE_MODE: "look" },
    modes: { folder: "yolo", risky: "default", all: "default" },
    instructionFile: "AGENTS.md",
  };

  test("the next turn sets it in the same session; a registry loading the pack again reads it", async () => {
    const agentsDir = join(dir, "agents");
    mkdirSync(join(agentsDir, "coder"), { recursive: true });
    writeFileSync(join(agentsDir, "coder", "IDENTITY.md"), "# IDENTITY\nCoder\n");
    writeFileSync(join(agentsDir, "coder", "config.toml"), '[agent]\nname = "Coder"\n\n[external]\ncli = "fake"\n');
    const open = () => AgentRegistry.create({ agentsDir, llmDefaults: { ...DEFAULT_CONFIG.llm.defaults, provider: "p", model: "m" }, knownClis: ["fake"] });
    const registry = await open();
    mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
    const state = stateRows();
    const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => dir, secretsFor: () => ({}), sessions: externalSessionsState(state), models: externalModelsState(state) });
    services.push(service);
    const turn = (text: string) => {
      const agent = registry.get("coder")!;
      const req = { agent, toolset: { definitions: [], get: () => undefined }, history: [], userMessage: { role: "user", content: text }, gateway: "telegram", gatewayId: "telegram:coder", chatId: "555", senderId: "555", senderName: "Mira" } as unknown as TurnRequest;
      return service.runnerFor(agent, { onActivity: () => {} } as unknown as ExecutorDeps)!.run(req);
    };

    await turn("one");
    const cli = await service.connection(registry.get("coder")!);
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");
    const told: string[] = [];
    const tool = createAgentConfigureTool({
      registry,
      agentsDir,
      providers: () => [],
      llm: LLM,
      cliModels: (agentId, id) => ({ name: service.row(id)?.name ?? id, offered: service.models.of(agentId), runsOn: service.models.runsOn(agentId) }),
      tell: async (_at, text) => Boolean(told.push(text)),
    });
    const result = await tool.execute({ model: "big" }, { ...ctx, agentId: "coder", gatewayId: "telegram:coder" } as ToolContext);
    expect(result.isError).toBe(false);
    expect(told).toEqual(['Coder changed its Fake CLI model from small to big, on the account "default". Every agent on that account shares its limits.']);

    await turn("two");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");
    expect(await stderrSaid(cli, (line) => line.startsWith("model:") || line.startsWith("cwd:"), 2)).toEqual([`cwd:${privateWorkspace(dir, "coder")}`, "model:big"]);
    expect((await open()).get("coder")?.config.external?.model).toBe("big");
  });
});
