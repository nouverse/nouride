/**
 * `content/` is a folder of this repository since 2026-11-06 (its own repository, `nouride-builtin-contents`,
 * a submodule from 0.8.12, went once Nouride itself was public). A built-in skill is the copy the installed release
 * carries (0.8.17): each one used to tell the model to read its newest version on that repository's `main`, so whatever
 * was pushed there changed every install's skill, whichever release it ran.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SKILLS = join(ROOT, "content/skills");

/** A copy of a skill on a branch, in any of the forms GitHub serves one: raw, or a page of the repository. */
const ON_A_BRANCH = [
  /raw\.githubusercontent\.com\/nouverse\/nouride-builtin-contents/,
  /raw\.githubusercontent\.com\/nouverse\/nouride\/[^\s]*content\/skills/,
  /github\.com\/nouverse\/nouride\/(?:blob|raw|tree)\/[^\s]*content\/skills/,
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

test("the content is a folder of this repository, not a submodule, and no workflow fetches it", () => {
  expect(readFileSync(join(ROOT, ".gitmodules"), "utf8")).not.toContain("content");
  const workflows = join(ROOT, ".github/workflows");
  for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
    expect({ file, fetches: readFileSync(join(workflows, file), "utf8").includes("--init content") }).toEqual({ file, fetches: false });
  }
});
