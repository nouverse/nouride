/**
 * What a push needs from CI beyond its checks (scripts/ci-changes.ts): the root helper's job, only when the helper or
 * the workflow that runs it changed. Everything else a push runs whatever it changed: `checks` reads the documentation
 * and the site as it reads code. A guess never skips the helper's job: a push whose files cannot be listed runs it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { needsOf } from "../../../../scripts/ci-changes.ts";

const CI = readFileSync(join(import.meta.dir, "../../../../.github/workflows/ci.yml"), "utf8");

test("the root helper's job only when the helper, or the workflow that runs it, changed", () => {
  expect(needsOf(["packages/isolation/root/nouride-run/src/main.rs"])).toEqual({ helper: true });
  expect(needsOf([".github/workflows/ci.yml"])).toEqual({ helper: true });
  // One helper file among others is enough.
  expect(needsOf(["README.md", "packages/isolation/scripts/test-root.sh"])).toEqual({ helper: true });
  for (const path of ["apps/engine/src/index.ts", "docs/ARCHITECTURE.md", "apps/site/src/consts.mjs", ".github/workflows/release.yml", "internals/pro", "package.json"]) {
    expect({ path, ...needsOf([path]) }).toEqual({ path, helper: false });
  }
});

test("a push whose files cannot be listed runs it", () => {
  expect(needsOf(null)).toEqual({ helper: true });
  expect(needsOf([])).toEqual({ helper: true });
});

test("ci.yml gates the helper's job on it, and nothing else: the checks run on every push, whatever it changed", () => {
  expect(CI).toContain('run: bun run scripts/ci-changes.ts "${BEFORE}" "${GITHUB_SHA}"');
  expect(CI).toMatch(/^ {2}helper:\n {4}needs: \[passed, changes\]\n {4}if: .*needs\.changes\.outputs\.helper == 'true'/m);
  // Documentation alone once ran a job of its own, and code another: `lint:check` and the contract tests read both.
  expect(CI).toMatch(/^ {2}checks:\n {4}needs: \[passed\]\n/m);
  expect(CI).not.toMatch(/needs\.changes\.outputs\.(?!helper\b)/);
});
