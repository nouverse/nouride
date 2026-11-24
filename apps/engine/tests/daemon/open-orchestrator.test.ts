/**
 * The orchestrator and an agent on a coding CLI are never open to everyone, whichever is asked for second.
 *
 * What makes an open agent safe is that it holds the daemon's four tools and reads nobody's memory. Neither holds for
 * these two: a coding CLI brings tools of its own that the daemon cannot take away, and the orchestrator is the agent
 * that holds the install. So each way of getting there is refused where it is asked: the dashboard's switch, a pack
 * handed to a CLI, the orchestrator changed, a save of the pack's file, a hand edit found at start.
 * A real registry over packs on disk, with the `refuse` boot gives it, the real setup service, file editor and preflight.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@nouride/persona";
import { SecretStore } from "@nouride/secrets";
import { addLogSink, type GlobalConfig } from "@nouride/shared";
import { refusedByThisInstall, runPreflightChecks } from "@/boot/preflight.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { stateRows } from "../helpers.ts";

const NOUVA = '[agent]\ndisplay_name = "Nouva"\n';
const NORA = '[agent]\ndisplay_name = "Nora"\n';
const CODER = '[agent]\ndisplay_name = "Coder"\n\n[external]\ncli = "codex"\n';
const OPEN = 'access = "open"\n';

const ORCHESTRATOR_NEVER_OPEN = "nouva is the orchestrator, the agent that holds this install, so it is never open to everyone. Make another agent for the public and open that one.";

let root: string;
let config: GlobalConfig;

function pack(id: string, toml: string): void {
  mkdirSync(join(root, "agents", id), { recursive: true });
  writeFileSync(join(root, "agents", id, "IDENTITY.md"), `${id}\n`);
  writeFileSync(join(root, "agents", id, "config.toml"), toml);
}

const configOf = (id: string) => readFileSync(join(root, "agents", id, "config.toml"), "utf8");

async function registry(): Promise<AgentRegistry> {
  return await AgentRegistry.create({
    agentsDir: config.daemon.agentsDir,
    llmDefaults: { ...DEFAULT_CONFIG.llm.defaults, provider: "p", model: "m" },
    knownClis: ["codex", "claude-code"],
    refuse: refusedByThisInstall(config),
  });
}

async function setup(agents: AgentRegistry): Promise<SetupService> {
  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  return new SetupService({
    config,
    configPath: join(root, "config.toml"),
    dataDir: config.daemon.dataDir,
    agentsDir: config.daemon.agentsDir,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    registry: agents,
    userCount: () => 1,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-open-orchestrator-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = join(root, "agents");
  config.daemon.workspaceDir = join(root, "workspace");
  config.daemon.orchestrator = "nouva";
  config.providers = {};
  config.gateways = [];
  mkdirSync(config.daemon.dataDir, { recursive: true });
  writeFileSync(join(root, "config.toml"), '[daemon]\norchestrator = "nouva"\n');
  pack("nouva", NOUVA);
  pack("nora", NORA);
  pack("coder", CODER);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("opening an agent to everyone", () => {
  test("is refused for the orchestrator and for an agent on a coding CLI, with nothing written; any other agent is opened", async () => {
    const agents = await registry();
    const service = await setup(agents);
    expect(await service.setAgentAccess({ agentId: "nouva", access: "open", actor: "t" })).toEqual({ ok: false, error: ORCHESTRATOR_NEVER_OPEN });
    expect(await service.setAgentAccess({ agentId: "coder", access: "open", actor: "t" })).toEqual({
      ok: false,
      error: "coder works through a coding CLI, which brings tools of its own that Nouride cannot take away, so it is never open to everyone. Open an agent that answers on a model instead.",
    });
    expect({ nouva: configOf("nouva"), coder: configOf("coder") }).toEqual({ nouva: NOUVA, coder: CODER });
    expect({ nouva: agents.get("nouva")?.config.access, coder: agents.get("coder")?.config.access }).toEqual({ nouva: undefined, coder: undefined });
    // The two may still be told who they take: the refusal is of `open` alone.
    expect(await service.setAgentAccess({ agentId: "nouva", access: "allowlist", actor: "t" })).toEqual({ ok: true });
    expect(await service.setAgentAccess({ agentId: "coder", access: "pair", actor: "t" })).toEqual({ ok: true });
    expect(await service.setAgentAccess({ agentId: "nora", access: "open", actor: "t" })).toEqual({ ok: true });
    expect({ file: configOf("nora"), loaded: agents.get("nora")?.config.access }).toEqual({ file: `${NORA}${OPEN}`, loaded: "open" });
  });
});

describe("an agent that is open to everyone", () => {
  test("is not made the orchestrator, and the install keeps the one it had", async () => {
    pack("nora", NORA + OPEN);
    const service = await setup(await registry());
    expect(await service.setOrchestrator({ agentId: "nora", actor: "t" })).toEqual({
      ok: false,
      error: "nora is open to everyone, so it cannot be the orchestrator, the agent that holds this install. Close it first, or make another agent the orchestrator.",
    });
    expect({ running: config.daemon.orchestrator, file: readFileSync(join(root, "config.toml"), "utf8") }).toEqual({ running: "nouva", file: '[daemon]\norchestrator = "nouva"\n' });
  });

  test("is not handed to a coding CLI, the choice itself refused; closed first, it is", async () => {
    pack("nora", NORA + OPEN);
    const agents = await registry();
    const service = await setup(agents);
    expect(await service.setAnsweredBy({ agentId: "nora", cli: "codex", actor: "t" })).toEqual({
      ok: false,
      field: "cli",
      error: "nora is open to everyone, so it cannot work through a coding CLI, which brings tools of its own that Nouride cannot take away. Close it first.",
    });
    expect({ file: configOf("nora"), external: agents.get("nora")?.config.external }).toEqual({ file: NORA + OPEN, external: undefined });
    expect(await service.setAgentAccess({ agentId: "nora", access: "pair", actor: "t" })).toEqual({ ok: true });
    expect(await service.setAnsweredBy({ agentId: "nora", cli: "codex", actor: "t" })).toEqual({ ok: true });
    expect(agents.get("nora")?.config.external).toEqual({ cli: "codex" });
  });
});

describe("a save of a pack's own file", () => {
  test("that makes the orchestrator open is put back, saying why, and the running agent stays closed", async () => {
    const agents = await registry();
    const files = new FileService({ agentsDir: config.daemon.agentsDir, configPath: join(root, "config.toml"), registry: agents, config });
    const saved = await files.write({ agentId: "nouva", name: "config.toml", content: NOUVA + OPEN, actor: "admin" });
    expect({ ok: saved.ok, error: saved.ok ? "" : saved.error }).toEqual({
      ok: false,
      error: `Saved nothing: with that change the agent no longer loads. agents/nouva/config.toml [agent] access = "open": ${ORCHESTRATOR_NEVER_OPEN}`,
    });
    expect({ file: configOf("nouva"), access: agents.get("nouva")?.config.access }).toEqual({ file: NOUVA, access: undefined });
    // Any other agent on a model is its own to open.
    expect(await files.write({ agentId: "nora", name: "config.toml", content: NORA + OPEN, actor: "admin" })).toMatchObject({ ok: true });
    expect(agents.get("nora")?.config.access).toBe("open");
  });

  test("that opens an agent on a coding CLI is put back by the pack's own load", async () => {
    const agents = await registry();
    const files = new FileService({ agentsDir: config.daemon.agentsDir, configPath: join(root, "config.toml"), registry: agents, config });
    const saved = await files.write({ agentId: "coder", name: "config.toml", content: `[agent]\ndisplay_name = "Coder"\n${OPEN}\n[external]\ncli = "codex"\n`, actor: "admin" });
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining("an agent on a coding CLI ([external]) is never open to everyone") });
    expect({ file: configOf("coder"), access: agents.get("coder")?.config.access }).toEqual({ file: CODER, access: undefined });
  });

  test("by hand, then reloaded, is refused the same way: every save of a pack ends in that reload", async () => {
    const agents = await registry();
    writeFileSync(join(root, "agents", "nouva", "config.toml"), NOUVA + OPEN);
    await expect(agents.reload("nouva")).rejects.toThrow("so it is never open to everyone");
    expect(agents.get("nouva")?.config.access).toBeUndefined();
  });
});

describe("a start with an open orchestrator on disk", () => {
  test("says so, keeps the orchestrator, and runs it closed: the install's own agent does not answer strangers", async () => {
    pack("nouva", NOUVA + OPEN);
    pack("nora", NORA + OPEN);
    const agents = await registry();
    const said: { message: string; hint?: unknown }[] = [];
    addLogSink((entry) => {
      if (entry.level === "warn") said.push({ message: entry.message, hint: (entry.data as { hint?: unknown } | undefined)?.hint });
    });
    runPreflightChecks({ config, registry: agents, providers: { available: () => [] } as never, credentialsDir: join(root, ".credentials"), state: stateRows() });
    expect(config.daemon.orchestrator).toBe("nouva");
    expect(agents.get("nouva")?.config.access).toBe("follow");
    expect(said).toContainEqual({
      message: 'agents/nouva/config.toml [agent] access = "open" is not taken: nouva is the orchestrator, and follows the install\'s access for this run',
      hint: ORCHESTRATOR_NEVER_OPEN,
    });
    // An agent that is not the orchestrator is left open, and nothing is said of it.
    expect(agents.get("nora")?.config.access).toBe("open");
    expect(said.filter((line) => line.message.includes("nora"))).toEqual([]);
  });
});
