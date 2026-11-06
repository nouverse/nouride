/**
 * Skills read again without a restart or a reload (0.8.13). Built-in skills were read only as the daemon started; a
 * reload reads them too but reconnects every agent's MCP servers. `refreshSkills` reads each agent's skills again and
 * leaves the rest of its pack — and its reload listeners — alone; `skillsStamp` says when the folders changed at all.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMDefaultsSection, LoadedAgent } from "@nouride/shared";
import { writeTextFile } from "@nouride/runtime";
import { AgentRegistry } from "../src/registry.ts";
import { skillsStamp } from "../src/skills.ts";

const DEFAULTS: LLMDefaultsSection = { provider: "anthropic", model: "claude-sonnet-4-20250514", maxTokens: 8192, temperature: 0.7 };
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

let agentsDir: string;
let builtinDir: string;

beforeEach(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-refresh-agents-"));
  builtinDir = mkdtempSync(join(tmpdir(), "nouride-refresh-skills-"));
  await writeTextFile(join(agentsDir, "nova", "IDENTITY.md"), "# IDENTITY\n- Name: nova\n");
  await writeTextFile(join(builtinDir, "slides", "SKILL.md"), skill("slides", "Make a deck."));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(builtinDir, { recursive: true, force: true });
});

test("a skill added or edited on disk reaches the agent, its own listeners told — not a reload's", async () => {
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS, builtinSkillsDir: builtinDir });
  const reloaded: string[] = [];
  const skillsChanged: LoadedAgent[] = [];
  registry.onReloaded((agent) => reloaded.push(agent.config.id));
  registry.onSkillsChanged((agent) => skillsChanged.push(agent));
  const names = () => registry.get("nova")!.skills.map((one) => one.name);
  expect(names()).toEqual(["slides"]);

  // Nothing changed: nobody is told.
  expect(await registry.refreshSkills()).toEqual([]);

  await writeTextFile(join(builtinDir, "diagrams", "SKILL.md"), skill("diagrams", "Draw boxes and arrows."));
  expect(await registry.refreshSkills()).toEqual(["nova"]);
  expect(names()).toEqual(["diagrams", "slides"]);

  await writeTextFile(join(builtinDir, "slides", "SKILL.md"), skill("slides", "Make a deck, measured and looked at."));
  expect(await registry.refreshSkills()).toEqual(["nova"]);
  expect(registry.get("nova")!.skills.find((one) => one.name === "slides")!.description).toBe("Make a deck, measured and looked at.");

  expect(skillsChanged.map((agent) => agent.skills.length)).toEqual([2, 2]);
  // A reload's listeners reconnect MCP servers: a skill is not a reason to.
  expect(reloaded).toEqual([]);
});

test("the stamp changes when a skill is added, removed or its SKILL.md edited — and not for a file beside it", async () => {
  const before = skillsStamp([builtinDir, join(agentsDir, "skills")]);
  await writeTextFile(join(builtinDir, "slides", "scripts", "render.mjs"), "// a script beside it\n");
  expect(skillsStamp([builtinDir, join(agentsDir, "skills")])).toBe(before);
  const later = new Date(Date.now() + 5_000);
  await writeTextFile(join(builtinDir, "slides", "SKILL.md"), skill("slides", "Make a deck."));
  utimesSync(join(builtinDir, "slides", "SKILL.md"), later, later);
  const edited = skillsStamp([builtinDir, join(agentsDir, "skills")]);
  expect(edited).not.toBe(before);
  await writeTextFile(join(agentsDir, "skills", "notes", "SKILL.md"), skill("notes", "Keep notes."));
  const added = skillsStamp([builtinDir, join(agentsDir, "skills")]);
  expect(added).not.toBe(edited);
  rmSync(join(agentsDir, "skills", "notes"), { recursive: true });
  expect(skillsStamp([builtinDir, join(agentsDir, "skills")])).toBe(edited);
});
