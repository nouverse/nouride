/**
 * `[tools] enabled = ["*"]` — every tool, now and in any later release.
 *
 * The setup wizard's first agent is written with it. A list spelled out at setup froze that agent at
 * the release it was made on: a box set up before `skill_search` existed never had it, and nothing said
 * so. The star is read as the whole list, so nothing else that reads `enabled` has to know about it; and
 * saving the tool switches keeps it, so the page never freezes it either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, BUILTIN_TOOLS, parseAgentConfig } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { setAgentTools } from "@/modules/setup/agent-access.ts";

const parse = (enabled: unknown) => parseAgentConfig("nouva", { tools: { enabled } } as never, { defaults: DEFAULT_CONFIG.llm.defaults });

describe("reading the star", () => {
  test("is every built-in tool, and says so", () => {
    const tools = parse(["*"]).tools;
    expect(tools.everyTool).toBe(true);
    expect(tools.enabled).toEqual([...BUILTIN_TOOLS]);
  });

  test("keeps any other name beside it — an MCP tool, say", () => {
    expect(parse(["*", "my_mcp_tool"]).tools.enabled).toContain("my_mcp_tool");
  });

  test("a list without it is the list, and not every tool", () => {
    const tools = parse(["read", "exec"]).tools;
    expect(tools.enabled).toEqual(["read", "exec"]);
    expect(tools.everyTool).toBeUndefined();
  });
});

describe("saving the tool switches", () => {
  let agentsDir: string;
  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "nouride-every-tool-"));
    mkdirSync(join(agentsDir, "nouva"));
    writeFileSync(join(agentsDir, "nouva", "IDENTITY.md"), "# IDENTITY\n- Name: Nouva\n");
    writeFileSync(join(agentsDir, "nouva", "config.toml"), '[tools]\nenabled = ["*"]\n');
  });
  afterEach(() => rmSync(agentsDir, { recursive: true, force: true }));

  async function save(tools: readonly string[]) {
    const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULT_CONFIG.llm.defaults });
    const available = BUILTIN_TOOLS.filter((name) => name !== "attachment_read");
    const result = await setAgentTools({ registry }, { agentId: "nouva", tools, available, actor: "t" });
    return { result, file: readFileSync(join(agentsDir, "nouva", "config.toml"), "utf8"), registry };
  }

  test("with every switch on, an agent on the star stays on it", async () => {
    const { result, file, registry } = await save(BUILTIN_TOOLS.filter((name) => name !== "attachment_read"));
    expect(result.ok).toBe(true);
    expect(file).toContain('enabled = ["*"]');
    expect(registry.get("nouva")?.config.tools.everyTool).toBe(true);
  });

  test("one switch off, and it is a list without that tool", async () => {
    const { file, registry } = await save(BUILTIN_TOOLS.filter((name) => name !== "attachment_read" && name !== "exec"));
    expect(file).not.toContain('"*"');
    expect(registry.get("nouva")?.config.tools.enabled).not.toContain("exec");
    expect(registry.get("nouva")?.config.tools.everyTool).toBeUndefined();
  });
});
