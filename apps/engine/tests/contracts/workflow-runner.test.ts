/**
 * A job that reads `CI_RUNNER` runs on GitHub's hosted runner or on the self-hosted build runner the variable
 * names. The hosted image carries rustup and the build runner does not, and `scripts/build/nouride-run.ts`
 * builds the root helper in the toolchain's container when rustup is missing; a step that calls rustup unguarded stops
 * that fallback before it can run: the Pro release, moved to the build runner, failed there with "rustup: command not
 * found" while the main repository's step had the guard.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
/** The Pro repository's workflows only where it is checked out: a public clone has the folder empty. */
const FOLDERS = [".github/workflows", "internals/pro/.github/workflows"].filter((folder) => existsSync(join(ROOT, folder)));

const workflows = FOLDERS.flatMap((folder) =>
  readdirSync(join(ROOT, folder))
    .filter((file) => file.endsWith(".yml"))
    .map((file) => ({ path: `${folder}/${file}`, text: readFileSync(join(ROOT, folder, file), "utf8") })),
);

/** Each step of a workflow, from its `- ` at a step's indent to the next one. */
function steps(text: string): string[] {
  return text.split(/\n(?=\s{6}- )/);
}

describe("a workflow runs on the hosted runner and on the build runner", () => {
  test("the main repository's workflows are read", () => {
    expect(workflows.some((workflow) => workflow.path === ".github/workflows/release.yml")).toBe(true);
  });

  for (const { path, text } of workflows) {
    test(`${path}: rustup is called only after asking whether this runner has it`, () => {
      const unguarded = steps(text).filter((step) => /^\s+rustup /m.test(step) && !step.includes("command -v rustup"));
      expect(unguarded.map((step) => step.trim().split("\n")[0])).toEqual([]);
    });
  }
});
