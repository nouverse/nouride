/**
 * An agent asks for a project's skills with `skill_root` (0.8.24): an approval at every level, `trusted` too, answered in
 * a chat by an admin only, as a change to its persona is — never a grant. The question names the folder and the skills
 * it brings. Approved, the folder is written as the Files tab's save writes it, audited with the agent's reason, and the
 * agent reloaded, so its next turn's list holds those skills; denied, the file is as it was. A folder that could not be
 * added is refused before anyone is asked. A coding CLI is lent it, and every agent that holds a tool has it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, ProjectSkills } from "@nouride/persona";
import { skipsApproval } from "@nouride/policy";
import type { GlobalConfig, Tool, ToolCall, ToolContext } from "@nouride/shared";
import { lends } from "@/modules/external-agents/lent-tools.ts";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SkillRoots } from "@/modules/setup/skill-roots.ts";
import { adminOnly } from "@/modules/tools/approval-answerers.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { createBuiltinTools, resolveToolset } from "@/modules/tools/registry.ts";
import { createSkillRootTool } from "@/modules/tools/builtins/skill-root.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

const PACK = '[llm]\nprovider = "test"\n';

let root = "";
let project = "";
let registry: AgentRegistry;
let audits: { action: string; actor: string; details?: Record<string, unknown> }[];
let tool: Tool;

beforeEach(async () => {
  root = tempDir("skill-root-tool");
  const agents = join(root, "agents");
  mkdirSync(join(agents, "nix"), { recursive: true });
  writeFileSync(join(agents, "nix", "IDENTITY.md"), "# IDENTITY\n- Name: Nix\n");
  writeFileSync(join(agents, "nix", "config.toml"), PACK);
  project = join(root, "home-app");
  for (const name of ["android-ui", "android-contributing"]) {
    mkdirSync(join(project, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} rules.\n---\n`);
  }
  mkdirSync(join(root, "install", "credentials"), { recursive: true });
  audits = [];
  registry = await AgentRegistry.create({ agentsDir: agents, llmDefaults: { provider: "test", model: "m", maxTokens: 1000, temperature: 0.5 }, knownProviders: ["test"] });
  const files = new FileService({
    agentsDir: agents,
    configPath: join(root, "config.toml"),
    registry,
    config: {} as GlobalConfig,
    audit: { record: (entry: { action: string; actor: string; details?: Record<string, unknown> }) => void audits.push(entry) } as never,
  });
  tool = createSkillRootTool({ roots: new SkillRoots({ registry, files, credentialsDir: join(root, "install", "credentials"), projectSkills: new ProjectSkills() }) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A call to `skill_root` through the executor's own caller, at an approval level, answered as `answer` says. */
async function request(args: Record<string, unknown>, answer: "approved" | "denied" = "approved", level: "careful" | "balanced" | "trusted" = "trusted") {
  const asks: ApprovalAsk[] = [];
  const toolset = {
    definitions: [tool.definition],
    get: (name: string): Tool | undefined => (name === "skill_root" ? tool : undefined),
    requiresApproval: () => true,
    parallelSafe: () => false,
    gate: (_name: string, callArgs: Record<string, unknown>, callCtx: ToolContext) => tool.gate!(callArgs, callCtx),
  };
  const approvals = {
    available: true,
    request: async (ask: ApprovalAsk) => {
      asks.push(ask);
      return answer === "approved" ? { status: "approved", id: "apr_1", by: "gading", decision: "allow-once" } : { status: "denied" };
    },
    previewOf: () => null,
  };
  const caller = new ToolCaller({ approvalLevel: () => level, approvals } as unknown as ExecutorDeps);
  const req = {
    toolset,
    agent: registry.get("nix"),
    sessionId: "ses_1",
    chatId: "555",
    gateway: "telegram",
    gatewayId: "telegram:nix",
    senderId: "555",
    chatType: "dm",
    workspaceRoots: [root],
  } as unknown as TurnRequest;
  const call: ToolCall = { id: "c1", name: "skill_root", arguments: args };
  return { result: await caller.run(req, call, 8_000), asks };
}

const pack = () => readFileSync(join(root, "agents", "nix", "config.toml"), "utf8");
const ADD = () => ({ action: "add", path: project, reason: "Asked to work on the Android app, whose rules are in its own skills." });

describe("an agent's request for a project's skills", () => {
  test("asked at every level, trusted too, of an admin only: never granted, the folder and its skills in the question", async () => {
    const { asks } = await request(ADD(), "denied", "trusted");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ tool: "skill_root", grantable: false, autoCoverable: false, hardlineClass: "persona" });
    expect(asks[0]!.reason).toBe(
      `nix asks to take the skills in ${project} as its own (android-contributing, android-ui): they become instructions it follows, ` +
        "a change to its persona, which an admin alone answers. Its reason: Asked to work on the Android app, whose rules are in its own skills",
    );
    expect(skipsApproval("trusted", "persona")).toBe(false);
    expect(adminOnly({ hardlineClass: "persona" })).toBe(true);
  });

  test("approved: written as the Files tab writes, audited with its reason, reloaded, and the next turn's list holds its skills", async () => {
    const { result } = await request(ADD());
    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      `${project} is one of your skill roots, as approved: its skills (android-contributing, android-ui) are in your list from your next turn. ` +
        "A coding CLI lists them when its next conversation opens (/new in a chat already going).",
    );
    expect(pack()).toBe(`${PACK}\n[workspace]\nskill_roots = ["${project}"]\n`);
    expect(readFileSync(join(root, "agents", "nix", "config.toml.bak.1"), "utf8")).toBe(PACK);
    expect(audits).toEqual([
      {
        action: "agent_file_edited",
        agentId: "nix",
        actor: "agent:nix",
        details: { file: "config.toml", bytes: pack().length, via: "skill_root", added: project, reason: "Asked to work on the Android app, whose rules are in its own skills." },
      } as never,
    ]);
    const skills = await new ProjectSkills().forAgent(registry.get("nix")!);
    expect(skills.map((skill) => skill.name).sort()).toEqual(["android-contributing", "android-ui"]);
  });

  test("denied: the file as it was, nothing kept, nothing reloaded, nothing audited", async () => {
    const { result } = await request(ADD(), "denied");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("A human denied this call");
    expect(pack()).toBe(PACK);
    expect(existsSync(join(root, "agents", "nix", "config.toml.bak.1"))).toBe(false);
    expect(registry.get("nix")?.config.skillRoots).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("a folder that could not be added is refused before anyone is asked: not there, the credentials folder's, one it has", async () => {
    const missing = await request({ ...ADD(), path: join(root, "not-cloned-yet") });
    expect(missing.asks).toEqual([]);
    expect(missing.result.content).toContain(`There is no folder at ${join(root, "not-cloned-yet")}.`);
    const keys = await request({ ...ADD(), path: join(root, "install") });
    expect(keys.asks).toEqual([]);
    expect(keys.result.content).toContain("holds the credentials folder");
    await request(ADD());
    const again = await request(ADD());
    expect(again.asks).toEqual([]);
    expect(again.result.content).toContain("is already one of nix's skill roots");
  });

  test("a reason is required, and in English, before anyone is asked", async () => {
    expect((await request({ action: "add", path: project })).asks).toEqual([]);
    const local = await request({ ...ADD(), reason: "Diminta mengerjakan aplikasi Android, aturannya ada di skill proyeknya sendiri." });
    expect(local.asks).toEqual([]);
    expect(pack()).toBe(PACK);
  });

  test("taken away when an admin approves; one that is not its own is refused before asking", async () => {
    await request(ADD());
    const removed = await request({ action: "remove", path: project, reason: "That work is done." });
    expect(removed.asks[0]?.reason).toBe(`nix asks to stop taking the skills in ${project}, a change to its persona, which an admin alone answers. Its reason: That work is done`);
    expect(removed.result.content).toBe(`${project} is no longer one of your skill roots, as approved: its skills leave your list from your next turn.`);
    expect(registry.get("nix")?.config.skillRoots).toEqual([]);
    const other = await request({ action: "remove", path: join(root, "elsewhere"), reason: "Tidy." });
    expect(other.asks).toEqual([]);
    expect(other.result.content).toContain("is not one of your skill roots");
  });
});

describe("who has it", () => {
  test("every agent that holds a tool, none that holds none; a coding CLI is lent it", () => {
    const tools = createBuiltinTools({ security: DEFAULT_CONFIG.security });
    const names = (enabled: string[]) =>
      resolveToolset(fakeAgent({ config: { ...fakeAgent().config, tools: { enabled, approvalRequired: [], blocked: [] } } }), tools, DEFAULT_CONFIG.security, { skillRootTool: tool }).definitions.map(
        (definition) => definition.name,
      );
    expect(names(["read"])).toContain("skill_root");
    expect(names([])).not.toContain("skill_root");
    expect(lends("skill_root")).toBe(true);
  });
});
