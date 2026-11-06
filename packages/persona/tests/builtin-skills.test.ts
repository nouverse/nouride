/**
 * Built-in skills — the ones that ship with the daemon, on unless switched off.
 *
 * The behaviour worth pinning down is not "they load". It is the two decisions that make them
 * different: the switch lives in `skills.toml` and is **default-on**, and a pool skill of the same
 * name **overrides** rather than duplicates. Both are easy to regress into something that still
 * looks like it works.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMDefaultsSection } from "@nouride/shared";
import { removePath, writeTextFile } from "@nouride/runtime";
import { loadAgent } from "../src/loader.ts";

const DEFAULTS: LLMDefaultsSection = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxTokens: 8192,
  temperature: 0.7,
};

let agentsDir: string;
let builtinDir: string;

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
}

/** A pack with nothing in it but the one file that has no sensible default. */
async function writePack(id: string, configToml = ""): Promise<void> {
  await writeTextFile(join(agentsDir, id, "IDENTITY.md"), `# IDENTITY\n- Name: ${id}\n`);
  if (configToml) await writeTextFile(join(agentsDir, id, "config.toml"), configToml);
}

async function load(id: string, offGlobally?: readonly string[] | (() => readonly string[])) {
  return loadAgent(id, {
    agentsDir,
    llmDefaults: DEFAULTS,
    builtinSkillsDir: builtinDir,
    ...(offGlobally ? { skillsOffGlobally: offGlobally } : {}),
  });
}

beforeAll(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-builtin-agents-"));
  builtinDir = mkdtempSync(join(tmpdir(), "nouride-builtin-skills-"));

  await writeTextFile(
    join(builtinDir, "document-authoring", "SKILL.md"),
    skill("document-authoring", "Typeset a PDF."),
  );
  await writeTextFile(
    join(builtinDir, "web-research", "SKILL.md"),
    skill("web-research", "Search and read."),
  );
  // Ships beside a skill and is not one. A skill that bundles files is the normal case, so this
  // must be skipped rather than loaded as a nameless entry.
  await writeTextFile(join(builtinDir, "document-authoring", "templates", "two-column.tex"), "%\n");
});

afterAll(async () => {
  await removePath(agentsDir);
  await removePath(builtinDir);
});

describe("builtin skills", () => {
  test("load with no configuration at all", async () => {
    // The point of the scope. A fresh install has an empty config.toml and should still be able to
    // do the things Nouride ships knowing how to do.
    await writePack("fresh");
    const agent = await load("fresh");

    expect(agent.skills.map((s) => s.name).sort()).toEqual(["document-authoring", "web-research"]);
    expect(agent.skills.every((s) => s.scope === "builtin")).toBe(true);
  });

  test("a directory with no SKILL.md is not a skill", async () => {
    await writePack("nested");
    const agent = await load("nested");

    expect(agent.skills.map((s) => s.name)).not.toContain("templates");
  });

  test("skills.toml switches one off and leaves the rest on", async () => {
    await writePack("picky");
    await writeTextFile(join(agentsDir, "picky", "skills.toml"), "[skills]\nweb-research = false\n");
    const agent = await load("picky");

    expect(agent.skills.map((s) => s.name)).toEqual(["document-authoring"]);
  });

  test("a skill added later stays on even when the deny list is non-empty", async () => {
    // The regression the default-on shape exists to prevent. With an opt-IN list, disabling one skill
    // would write an explicit roster, and every skill shipped in a later release would arrive
    // switched off on that install with nothing to say why. A map of decisions cannot do that.
    await writePack("upgraded");
    await writeTextFile(join(agentsDir, "upgraded", "skills.toml"), "[skills]\nweb-research = false\n");
    await writeTextFile(
      join(builtinDir, "shipped-later", "SKILL.md"),
      skill("shipped-later", "Arrived in a release after the operator last touched the toggle."),
    );

    const agent = await load("upgraded");
    expect(agent.skills.map((s) => s.name).sort()).toEqual(["document-authoring", "shipped-later"]);

    await removePath(join(builtinDir, "shipped-later"));
  });

  test("a pool skill of the same name overrides the built-in one, and does not duplicate it", async () => {
    // The whole override story: copy it into `agents/skills/` and edit. Two entries with one name and
    // different bodies would leave the model to pick, with nothing in the prompt to pick on.
    await writePack("override");
    await writeTextFile(
      join(agentsDir, "skills", "document-authoring", "SKILL.md"),
      skill("document-authoring", "Our house style, not the shipped one."),
    );

    const agent = await load("override");
    const matches = agent.skills.filter((s) => s.name === "document-authoring");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.scope).toBe("shared");
    expect(matches[0]?.description).toBe("Our house style, not the shipped one.");

    await removePath(join(agentsDir, "skills", "document-authoring"));
  });

  test("one switch covers both scopes", async () => {
    // The simplification this release is: an operator switching a skill off should not have to know
    // whether it shipped with the daemon or was written by an agent. One file, one name, one answer.
    await writePack("uniform");
    await writeTextFile(
      join(agentsDir, "skills", "house-style", "SKILL.md"),
      skill("house-style", "Written here."),
    );
    await writeTextFile(
      join(agentsDir, "uniform", "skills.toml"),
      "[skills]\nhouse-style = false\nweb-research = false\n",
    );

    const agent = await load("uniform");
    expect(agent.skills.map((s) => s.name)).toEqual(["document-authoring"]);

    await removePath(join(agentsDir, "skills", "house-style"));
  });

  test("no builtin directory means no builtin skills, not a failure", async () => {
    // An install built without them, or an operator who deleted the directory. The daemon still
    // boots and the agent still loads; it simply knows fewer things.
    await writePack("bare");
    const agent = await loadAgent("bare", { agentsDir, llmDefaults: DEFAULTS });

    expect(agent.skills).toEqual([]);
  });
});

/**
 * `[skills] off` — the operator's axis, over the top of every pack's own answer.
 *
 * A built-in has no other removal: it ships inside the executable, so `DELETE /skills/:name` refuses
 * it and a deletion would be undone by the next upgrade. The tempting implementation is to write
 * `false` into every pack, and these tests are here because that implementation is wrong in a way
 * nobody would notice for weeks.
 */
describe("[skills] off", () => {
  test("a skill named there is not loaded, whatever the pack says", async () => {
    await writePack("opted-in", '[skills]\n"document-authoring" = true\n');
    const agent = await load("opted-in", ["document-authoring"]);
    expect(agent.skills.map((s) => s.name)).not.toContain("document-authoring");
    // The others are untouched — this is a list, not a switch for the whole pool.
    expect(agent.skills.map((s) => s.name)).toContain("web-research");
  });

  test("it applies to an agent created after the switch, which is the whole point", async () => {
    /**
     * The failure mode of the obvious implementation. Fanning `false` across every `skills.toml`
     * would leave this agent — written later, with no opinion about the skill — carrying it again,
     * with nothing anywhere to say why.
     */
    await writePack("created-later");
    const agent = await load("created-later", ["document-authoring"]);
    expect(agent.skills.map((s) => s.name)).not.toContain("document-authoring");
  });

  test("an empty list changes nothing", async () => {
    await writePack("untouched");
    const agent = await load("untouched", []);
    expect(agent.skills.map((s) => s.name).sort()).toEqual(["document-authoring", "web-research"]);
  });

  test("a name that matches nothing is ignored rather than refused", async () => {
    // A skill switched off and then deleted would otherwise make the config unloadable, and "off" is
    // the one state where a missing skill is not a problem.
    await writePack("stale-entry");
    const agent = await load("stale-entry", ["deleted-months-ago"]);
    expect(agent.skills.map((s) => s.name).sort()).toEqual(["document-authoring", "web-research"]);
  });

  test("it is read at load time, so a change lands on the next reload", async () => {
    /**
     * Why the option accepts a function. The registry reloads packs without restarting the daemon,
     * and a snapshot taken at boot would leave the dashboard reporting a switch that had not taken
     * effect until somebody restarted — the worst kind of setting, the one that lies.
     */
    const off: string[] = [];
    await writePack("live");
    expect((await load("live", () => off)).skills.map((s) => s.name)).toContain("document-authoring");

    off.push("document-authoring");
    expect((await load("live", () => off)).skills.map((s) => s.name)).not.toContain("document-authoring");
  });
});
