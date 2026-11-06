/**
 * The orchestrator made external while the daemon runs (0.8.1). A Files-tab save adding `[external]` to its config.toml
 * was taken, and the next start refused the file — a restart or the nightly update crash-looped every agent. A save is
 * put back now, saying why; a hand edit that still gets there is said at start, which runs with no orchestrator.
 * A real registry over packs on disk, with the `refuse` boot gives it, and the real file editor and preflight.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@nouride/persona";
import { addLogSink, type GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { FileService } from "@/modules/setup/files.ts";
import { refusingExternalOrchestrator, runPreflightChecks } from "@/boot/preflight.ts";
import { stateRows } from "../helpers.ts";

const PACK = '[agent]\ndisplay_name = "Nouva"\n';
const EXTERNAL = '\n[external]\ncli = "codex"\n';

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
    refuse: refusingExternalOrchestrator(config),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-external-orchestrator-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = join(root, "agents");
  config.daemon.workspaceDir = join(root, "workspace");
  config.daemon.orchestrator = "nouva";
  config.gateways = [];
  mkdirSync(config.daemon.dataDir, { recursive: true });
  pack("nouva", PACK);
  pack("nix", '[agent]\ndisplay_name = "Nix"\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a save that makes the orchestrator external", () => {
  test("from the Files tab is put back, saying why, and the running agent stays a Nouride one", async () => {
    const agents = await registry();
    const files = new FileService({ agentsDir: config.daemon.agentsDir, configPath: join(root, "config.toml"), registry: agents, config });
    const saved = await files.write({ agentId: "nouva", name: "config.toml", content: PACK + EXTERNAL, actor: "admin" });
    expect({ ok: saved.ok, error: saved.ok ? "" : saved.error }).toEqual({
      ok: false,
      error:
        "Saved nothing: with that change the agent no longer loads. agents/nouva/config.toml [external]: nouva is an external agent: " +
        "Nouride's approval level, fixed list and tool switches do not reach its coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. Make a Nouride agent the orchestrator, and hand work to nouva with ask_agent.",
    });
    expect({ file: configOf("nouva"), external: agents.get("nouva")?.config.external }).toEqual({ file: PACK, external: undefined });
    // Any other agent is its own to hand to a CLI.
    expect(await files.write({ agentId: "nix", name: "config.toml", content: `[agent]\ndisplay_name = "Nix"\n${EXTERNAL}`, actor: "admin" })).toMatchObject({ ok: true });
    expect(agents.get("nix")?.config.external).toEqual({ cli: "codex" });
  });

  test("by hand, then reloaded, is refused the same way — every save of a pack ends in that reload", async () => {
    const agents = await registry();
    writeFileSync(join(root, "agents", "nouva", "config.toml"), PACK + EXTERNAL);
    await expect(agents.reload("nouva")).rejects.toThrow("Make a Nouride agent the orchestrator");
    expect(agents.get("nouva")?.config.external).toBeUndefined();
  });
});

describe("a start with an external orchestrator on disk", () => {
  test("says so and runs with no orchestrator, rather than refusing to start", async () => {
    pack("nouva", PACK + EXTERNAL);
    const agents = await registry();
    const said: string[] = [];
    addLogSink((entry) => {
      if (entry.level === "warn") said.push(entry.message);
    });
    runPreflightChecks({ config, registry: agents, providers: { available: () => [] } as never, credentialsDir: join(root, ".credentials"), state: stateRows() });
    expect(config.daemon.orchestrator).toBeUndefined();
    expect(said).toContain("config.toml [daemon] orchestrator names nouva, an external agent, so this start runs with no orchestrator");
    // The agent itself loads and answers through its CLI.
    expect(agents.get("nouva")?.config.external).toEqual({ cli: "codex" });
  });
});
