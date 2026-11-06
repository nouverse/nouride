/**
 * `content/` is its own public repository, `nouverse/nouride-builtin-contents` (0.8.12). A built-in skill is the copy the
 * installed release carries (0.8.17): each one used to tell the model to read its newest version on that repository's
 * `main`, so whatever was pushed there changed every install's skill, whichever release it ran. And every workflow job
 * that checks the repository out takes the content with it: CI checks out no submodules by default, and a job without
 * it would test, build or publish with no skills at all.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SKILLS = join(ROOT, "content/skills");

/** A copy of a skill on a branch, in any of the forms GitHub serves one: raw, or a page of the repository. */
const ON_A_BRANCH = [
  /raw\.githubusercontent\.com\/nouverse\/nouride-builtin-contents/,
  /github\.com\/nouverse\/nouride-builtin-contents\/(?:blob|raw|tree)\//,
  /newest (?:version|copy) of this skill/i,
];

describe("a built-in skill is the copy the release carries", () => {
  const names = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  test("there are skills to check", () => {
    expect(names.length).toBeGreaterThan(5);
  });

  for (const name of names) {
    test(`${name}: no file of it sends the model to a newer copy on GitHub`, () => {
      const files = readdirSync(join(SKILLS, name), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
      const found = files.flatMap((entry) => {
        const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
        return ON_A_BRANCH.filter((pattern) => pattern.test(text)).map((pattern) => `${entry.name}: ${pattern}`);
      });
      expect(found).toEqual([]);
    });
  }
});

test("every workflow job that starts clean checks the content out", () => {
  const workflows = join(ROOT, ".github/workflows");
  for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(workflows, file), "utf8");
    const clean = text.split("- name: Start without the last job's submodules").length - 1;
    const content = text.split("run: git submodule update --init content").length - 1;
    expect(`${file}: ${content} of ${clean}`).toBe(`${file}: ${clean} of ${clean}`);
    // Each its own step after the clearing one's `run`: one wedged between a step's `if:` and its `run:` gave that step
    // two `run` keys, and GitHub refused the whole release workflow (0.8.12).
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.trim() !== "- name: Check out the built-in content") return;
      const before = lines.slice(0, i).filter((l) => !l.trim().startsWith("#")).at(-1)?.trim() ?? "";
      const clearing = "run: if git config --get-regexp";
      expect(`${file}:${i + 1} after: ${before.slice(0, clearing.length)}`).toBe(`${file}:${i + 1} after: ${clearing}`);
    });
  }
});

test("the content is the public repository, as a submodule", () => {
  expect(readFileSync(join(ROOT, ".gitmodules"), "utf8")).toContain('[submodule "content"]\n\tpath = content\n\turl = https://github.com/nouverse/nouride-builtin-contents.git');
});
