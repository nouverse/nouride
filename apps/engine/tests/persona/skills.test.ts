/**
 * `skill_create` and `skill_toggle` — the agent's own half of the skill pool.
 *
 * The invariant these guard: there is **one** pool every agent can see, an agent's switch lands in
 * `agents/<id>/skills.toml` and touches nothing else, and a skill an agent writes is on for that agent
 * (0.7.27) and checked like a draft.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists, removePath, writeTextFile } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createSkillCreateTool, createSkillToggleTool } from "@/modules/tools/builtins/skills.ts";
import { tempDir, writeAgentPack } from "../helpers.ts";
import { holdLines, type LogEntry, type ToolContext } from "@nouride/shared";

let agentsDir: string;
let builtinDir: string;
let registry: AgentRegistry;

const ctx = (agentId = "nouva"): ToolContext => ({
  agentId,
  sessionId: "ses_1",
  chatId: "chat-1",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
    chatType: "dm",
  workspaceDir: join(agentsDir, agentId),
  agentDir: join(agentsDir, agentId),
  workspaceRoots: [join(agentsDir, agentId)],
  signal: new AbortController().signal,
});

/** A skill in the pool, which is the only place skills live. */
async function pooled(name: string, description = "d"): Promise<void> {
  await writeTextFile(
    join(agentsDir, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
}

beforeEach(async () => {
  agentsDir = tempDir("skills");
  builtinDir = tempDir("skills-builtin");
  await writeAgentPack(agentsDir, { id: "nouva", configToml: "[agent]\nenabled = true\n" });
  await writeAgentPack(agentsDir, { id: "nix", configToml: "[agent]\nenabled = true\n" });
  registry = await AgentRegistry.create({
    agentsDir,
    llmDefaults: DEFAULT_CONFIG.llm.defaults,
    builtinSkillsDir: builtinDir,
  });
});

afterEach(() => {
  removePath(agentsDir);
  removePath(builtinDir);
});

/** `[skills] off`, as the operator has it — read by the toggle tool when it is called. */
let offGlobally: string[] = [];
beforeEach(() => {
  offGlobally = [];
});

function tools() {
  const options = { registry, agentsDir, builtinSkillsDir: builtinDir, skillsOffGlobally: () => offGlobally };
  return {
    create: createSkillCreateTool(options),
    toggle: createSkillToggleTool(options),
  };
}

describe("skill_create", () => {
  test("writes into the shared pool, on for the agent that wrote it — another switches it on itself", async () => {
    const result = await tools().create.execute(
      {
        name: "release-checklist",
        description: "Steps before tagging a release",
        body: "1. Run the tests.\n2. Check the changelog.",
      },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const source = await readTextFileIfExists(
      join(agentsDir, "skills", "release-checklist", "SKILL.md"),
    );
    expect(source).toContain("name: release-checklist");
    expect(source).toContain("description: Steps before tagging a release");
    expect(source).toContain("1. Run the tests.");
    expect(source).toContain("agents: nouva");
    expect(result.content).toContain("on for you");

    // One pool, not one prompt: nix can see it and switch it on, with no restart, but does not carry it unasked.
    expect(registry.get("nouva")?.skills.map((s) => s.name)).toContain("release-checklist");
    expect(registry.get("nix")?.skills.map((s) => s.name)).not.toContain("release-checklist");
    await tools().toggle.execute({ name: "release-checklist", enabled: true }, ctx("nix"));
    expect(registry.get("nix")?.skills.map((s) => s.name)).toContain("release-checklist");
  });

  test.each([
    ["a machine's address", { description: "Use when a pod is stuck.", body: "ssh root@172.16.42.5 and restart it." }, /address \(172\.16\.42\.5\).*memory/],
    ["an account", { description: "Use when a pod is stuck.", body: "Log in as ops@nouverse.tech first." }, /account \(ops@nouverse\.tech\)/],
    ["a session told", { description: "Use when a pod is stuck.", body: "In this session the user asked me to restart it." }, /tells a session/],
    ["an edit note for a description", { description: "Updated the restart steps", body: "1. Restart it." }, /says what was changed/],
  ])("refuses a skill that holds %s, and writes nothing", async (_label, fields, reason) => {
    // The other door into the pool: an agent asked to "save this as a skill" calls this, not the reflection pass.
    const result = await tools().create.execute({ name: "restart-stuck-pod", ...fields }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(reason);
    expect(result.content).toContain("Not written");
    expect(await readTextFileIfExists(join(agentsDir, "skills", "restart-stuck-pod", "SKILL.md"))).toBeNull();
  });

  test("no per-agent skills folder is created", async () => {
    // The regression this guards: `agents/<id>/skills/` is gone, and a skill written there would be
    // loaded by nobody while looking exactly like a skill.
    await tools().create.execute({ name: "audit", description: "d", body: "b" }, ctx());
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills", "audit", "SKILL.md"))).toBeNull();
  });

  test("records requires: in the frontmatter so a missing program is visible", async () => {
    await tools().create.execute(
      { name: "graphs", description: "d", body: "b", requires: "dot, playwright" },
      ctx(),
    );
    const source = await readTextFileIfExists(join(agentsDir, "skills", "graphs", "SKILL.md"));
    expect(source).toContain("requires: dot, playwright");
    expect(registry.get("nouva")?.skills.find((s) => s.name === "graphs")?.requires).toEqual([
      "dot",
      "playwright",
    ]);
  });

  test("refuses to overwrite an existing skill", async () => {
    const { create } = tools();
    const args = { name: "audit", description: "d", body: "b" };
    await create.execute(args, ctx());

    // A skill someone has been refining must not be clobbered because a model reused a name.
    const second = await create.execute({ ...args, body: "different" }, ctx());
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/already exists/);
    expect(
      await readTextFileIfExists(join(agentsDir, "skills", "audit", "SKILL.md")),
    ).toContain("b");
  });

  test.each([
    ["an empty name", { name: "", description: "d", body: "b" }, /not a valid skill name/],
    ["capitals", { name: "Bad Name", description: "d", body: "b" }, /not a valid skill name/],
    ["no description", { name: "ok", description: "", body: "b" }, /description` is required/],
    ["no body", { name: "ok", description: "d", body: "" }, /body` is required/],
  ])("refuses %s", async (_label, args, expected) => {
    const result = await tools().create.execute(args, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(expected);
  });

  test("flattens a multi-line description so the frontmatter stays parseable", async () => {
    // Frontmatter is `key: value` lines, not YAML — a newline would end the block early and the
    // skill would load with no description, which is how it gets matched.
    await tools().create.execute(
      { name: "multi", description: "first line\nsecond line", body: "b" },
      ctx(),
    );

    const source = await readTextFileIfExists(join(agentsDir, "skills", "multi", "SKILL.md"));
    expect(source).toContain("description: first line second line");
    expect(registry.get("nouva")?.skills.find((s) => s.name === "multi")?.description).toBe(
      "first line second line",
    );
  });
});

describe("skill_toggle", () => {
  test("lists everything, including what this agent is not carrying", async () => {
    await pooled("github", "Talk to GitHub");
    await pooled("web-research", "How to research");
    await writeTextFile(
      join(agentsDir, "nouva", "skills.toml"),
      "[skills]\nweb-research = false\n",
    );
    await registry.reload("nouva");

    const result = await tools().toggle.execute({}, ctx());
    expect(result.isError).toBe(false);
    // The listing is the only way an agent can learn the name of a skill it does not have: the
    // prompt names the ones that are on.
    expect(result.content).toContain("[on] github");
    expect(result.content).toContain("[off] web-research");
  });

  test("switching off writes skills.toml and drops it from the prompt", async () => {
    await pooled("github");
    await registry.reload("nouva");

    const result = await tools().toggle.execute({ name: "github", enabled: false }, ctx());
    expect(result.isError).toBe(false);
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills.toml"))).toContain(
      "github = false",
    );
    expect(registry.get("nouva")?.skills.map((s) => s.name)).not.toContain("github");
  });

  test("one agent's decision leaves the others alone", async () => {
    await pooled("github");
    await registry.reloadAll();

    await tools().toggle.execute({ name: "github", enabled: false }, ctx("nouva"));
    // The failure this guards is a toggle written to a shared file: switching a skill off for one
    // agent must not take it from its siblings.
    expect(registry.get("nix")?.skills.map((s) => s.name)).toContain("github");
    expect(await readTextFileIfExists(join(agentsDir, "nix", "skills.toml"))).toBeNull();
  });

  test("switching one back on restores it", async () => {
    await pooled("github");
    await writeTextFile(join(agentsDir, "nouva", "skills.toml"), "[skills]\ngithub = false\n");
    await registry.reload("nouva");

    const result = await tools().toggle.execute({ name: "github", enabled: true }, ctx());
    expect(result.isError).toBe(false);
    expect(registry.get("nouva")?.skills.map((s) => s.name)).toContain("github");
  });

  test("a built-in skill can be switched off too", async () => {
    await writeTextFile(
      join(builtinDir, "document-authoring", "SKILL.md"),
      "---\nname: document-authoring\ndescription: d\n---\nb\n",
    );
    await registry.reload("nouva");

    await tools().toggle.execute({ name: "document-authoring", enabled: false }, ctx());
    expect(registry.get("nouva")?.skills.map((s) => s.name)).not.toContain("document-authoring");
  });

  test("refuses a skill that does not exist, and says what does", async () => {
    await pooled("github");
    const result = await tools().toggle.execute({ name: "ghost", enabled: true }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no skill called "ghost"/);
    expect(result.content).toContain("github");
  });

  test("naming a skill without `enabled` is refused rather than guessed", async () => {
    await pooled("github");
    const result = await tools().toggle.execute({ name: "github" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/`enabled` is required/);
  });

  /**
   * The listing follows the prompt's rules. It concatenated both pools with neither: an overridden built-in was listed
   * twice, and a skill switched off for everyone read `[on]`.
   */
  test("lists an overridden built-in once, and a globally-off skill as off", async () => {
    await pooled("document-authoring", "the operator's copy");
    await writeTextFile(join(builtinDir, "document-authoring", "SKILL.md"), "---\nname: document-authoring\ndescription: shipped\n---\nb\n");
    await pooled("github");
    offGlobally = ["github"];

    const result = await tools().toggle.execute({}, ctx());
    expect(result.content.match(/document-authoring/g)).toHaveLength(1);
    expect(result.content).toContain("[on] document-authoring: the operator's copy");
    expect(result.content).toContain("[off] github (off for every agent)");
  });

  test("switching on a skill that is off for everyone is refused, and nothing is written", async () => {
    await pooled("github");
    await writeTextFile(join(agentsDir, "nouva", "skills.toml"), "[skills]\ngithub = false\n");
    offGlobally = ["github"];

    const result = await tools().toggle.execute({ name: "github", enabled: true }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[skills] off");
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills.toml"))).toBe("[skills]\ngithub = false\n");
  });

  test("switching to the state it already has changes nothing", async () => {
    await pooled("github");
    await registry.reload("nouva");

    const result = await tools().toggle.execute({ name: "github", enabled: true }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/already on/);
    // No file written: a no-op must not leave a diff in the pack.
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills.toml"))).toBeNull();
  });
});

describe("skills.toml", () => {
  test("a switch for a skill a merge archived is kept and not said; a misspelt one still is (0.8.8, the live box)", async () => {
    // Two merges archived deployment and github-pr; every reload after said both "do not exist" for each agent that had
    // switched them off — three agents, on every skill approved after.
    await pooled("infrastructure-ops");
    await writeTextFile(join(agentsDir, "skills", ".archive", "deployment", "SKILL.md"), "---\nname: deployment\ndescription: d\n---\nbody\n");
    await writeTextFile(join(agentsDir, "nouva", "skills.toml"), "[skills]\ndeployment = false\ninfrastructre-ops = false\n");
    const release = holdLines();
    let said: LogEntry[];
    try {
      await registry.reload("nouva");
    } finally {
      said = release();
    }
    const unknown = said.filter((line) => line.message === "skills.toml names skills that do not exist");
    expect(unknown.map((line) => line.data?.unknown)).toEqual([["infrastructre-ops"]]);
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills.toml"))).toContain("deployment = false");
  });
});
