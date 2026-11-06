/**
 * The reflection pass reads the support files its listing showed it, whatever their case (0.8.22). Shown
 * `references/INFRASTRUCTURE.md` and refused it by the lowercase pattern that governs writing, it spent every round of
 * the pass asking again and answered nothing (live, 2026-11-06).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkillFiles, readPool, readSkillFile } from "@/modules/reflection/pool.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An install's agents folder with one skill and its references, as the live one has them, and a file beside it. */
function agentsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "nr-reflect-"));
  dirs.push(root);
  const skill = join(root, "skills", "infrastructure-ops");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: infrastructure-ops\ndescription: Operating the homelab\n---\n\n# Infrastructure ops\n");
  writeFileSync(join(skill, "references", "INFRASTRUCTURE.md"), "# Hosts\n");
  writeFileSync(join(skill, "references", "lxc_storage_tmpfs.md"), "# tmpfs\n");
  writeFileSync(join(skill, "references", ".notes"), "not a support file\n");
  writeFileSync(join(root, "config.toml"), "outside the skill\n");
  return root;
}

test("a support file it was shown is read, whatever its case", async () => {
  const pool = await readPool(agentsDir());
  expect((await listSkillFiles(pool, "infrastructure-ops")).sort()).toEqual(["references/INFRASTRUCTURE.md", "references/lxc_storage_tmpfs.md"]);
  expect(await readSkillFile(pool, "infrastructure-ops", "references/INFRASTRUCTURE.md")).toBe("# Hosts\n");
  expect(await readSkillFile(pool, "infrastructure-ops", "references/lxc_storage_tmpfs.md")).toBe("# tmpfs\n");
});

test("nothing it was not shown: a dotfile, a path out of the skill, a file not there, a skill not in the pool", async () => {
  const pool = await readPool(agentsDir());
  expect(await readSkillFile(pool, "infrastructure-ops", "references/.notes")).toBeNull();
  expect(await readSkillFile(pool, "infrastructure-ops", "../../config.toml")).toBeNull();
  expect(await readSkillFile(pool, "infrastructure-ops", "references/../../../config.toml")).toBeNull();
  expect(await readSkillFile(pool, "infrastructure-ops", "references/missing.md")).toBeNull();
  expect(await readSkillFile(pool, "nobody", "references/INFRASTRUCTURE.md")).toBeNull();
});
