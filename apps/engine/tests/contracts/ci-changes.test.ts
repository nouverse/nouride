/**
 * What a push needs from CI (scripts/ci-changes.ts; the owner, 2026-11-06): the suite only when code changed, a light
 * job for documentation and the site, and the root helper's job only when the helper changed. A guess never skips the
 * full run: what cannot be classified is code.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { needsOf } from "../../../../scripts/ci-changes.ts";

const CI = readFileSync(join(import.meta.dir, "../../../../.github/workflows/ci.yml"), "utf8");

test("documentation and the site alone need only the light job", () => {
  expect(needsOf(["docs/ARCHITECTURE.md", "apps/site/src/content/docs/en/docs/manual/knowledge.md", "README.md", "LICENSE"])).toEqual({ code: false, helper: false, docs: true });
  expect(needsOf(["docs/releases/v0.8.21.md"])).toEqual({ code: false, helper: false, docs: true });
});

test("anything the suite reads as code, or runs, needs the full jobs", () => {
  for (const path of ["apps/engine/src/index.ts", "content/skills/x/SKILL.md", "docs/EVENTS.md", "docs/contracts/events.v1.json", "apps/site/src/consts.mjs", ".github/workflows/release.yml", "internals/pro", "package.json"]) {
    expect({ path, code: needsOf([path]).code }).toEqual({ path, code: true });
  }
  // One code file among the documentation is enough.
  expect(needsOf(["README.md", "packages/runtime/src/fs.ts"]).code).toBe(true);
});

test("the root helper's job only when the helper, or the workflow that runs it, changed", () => {
  expect(needsOf(["packages/isolation/root/nouride-run/src/main.rs"]).helper).toBe(true);
  expect(needsOf([".github/workflows/ci.yml"]).helper).toBe(true);
  expect(needsOf(["apps/engine/src/index.ts"]).helper).toBe(false);
});

test("a push whose files cannot be listed runs everything", () => {
  expect(needsOf(null)).toEqual({ code: true, helper: true, docs: true });
  expect(needsOf([])).toEqual({ code: true, helper: true, docs: true });
});

test("ci.yml gates each job on it", () => {
  expect(CI).toContain('run: bun run scripts/ci-changes.ts "${BEFORE}" "${GITHUB_SHA}"');
  expect(CI).toMatch(/^ {2}verify:\n {4}needs: \[passed, changes\]\n(?: {4}#.*\n)* {4}if: .*needs\.changes\.outputs\.code == 'true'/m);
  expect(CI).toMatch(/^ {2}verify-private:\n {4}needs: \[passed, changes\]\n {4}if: .*needs\.changes\.outputs\.code == 'true'/m);
  expect(CI).toMatch(/^ {2}helper:\n {4}needs: \[passed, changes\]\n {4}if: .*needs\.changes\.outputs\.helper == 'true'/m);
  expect(CI).toMatch(/^ {2}docs:\n {4}needs: \[changes\]\n {4}if: \$\{\{ needs\.changes\.outputs\.code != 'true' && needs\.changes\.outputs\.docs == 'true'/m);
});
