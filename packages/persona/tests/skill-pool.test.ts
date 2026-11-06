/**
 * Which skills an agent has — decided once, in `agentSkillPool`, for the prompt and for every listing of it.
 *
 * Two rules: a pool skill overrides a built-in of the same name, and `[skills] off` takes a skill from every agent
 * whatever its own switch says. The prompt applied both; an agent's Skills tab and its `skill_toggle` listing applied
 * neither, so they showed a globally-off skill as on and an overridden built-in twice.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePath, writeTextFile } from "@nouride/runtime";
import { agentSkillPool } from "../src/skills.ts";

let poolDir: string;
let builtinDir: string;

const skill = (dir: string, name: string, description: string) =>
  writeTextFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);

beforeAll(async () => {
  poolDir = mkdtempSync(join(tmpdir(), "skill-pool-"));
  builtinDir = mkdtempSync(join(tmpdir(), "skill-pool-builtin-"));
  await skill(poolDir, "document-reading", "the operator's own copy");
  await skill(poolDir, "deploy", "ship it");
  await skill(builtinDir, "document-reading", "as shipped");
  await skill(builtinDir, "web-research", "search well");
});

afterAll(() => {
  removePath(poolDir);
  removePath(builtinDir);
});

describe("agentSkillPool", () => {
  test("a pool skill overrides a built-in of its name: listed once, the pool's copy", async () => {
    const pool = await agentSkillPool({ poolDir, builtinDir, states: {} });
    expect(pool.map((s) => `${s.scope}:${s.name}`)).toEqual(["shared:deploy", "shared:document-reading", "builtin:web-research"]);
    expect(pool.find((s) => s.name === "document-reading")?.description).toBe("the operator's own copy");
  });

  test("[skills] off is said per skill, beside the agent's own switch rather than folded into it", async () => {
    const pool = await agentSkillPool({ poolDir, builtinDir, states: { deploy: false }, offGlobally: ["web-research"] });
    const by = Object.fromEntries(pool.map((s) => [s.name, { enabled: s.enabled, offGlobally: s.offGlobally }]));
    expect(by).toEqual({
      deploy: { enabled: false, offGlobally: false },
      "document-reading": { enabled: true, offGlobally: false },
      "web-research": { enabled: true, offGlobally: true },
    });
  });

  test("without a built-in directory, the pool alone", async () => {
    expect((await agentSkillPool({ poolDir, states: {} })).map((s) => s.name)).toEqual(["deploy", "document-reading"]);
  });
});
