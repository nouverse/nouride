/**
 * A test that cannot run says so: `test.skipIf`, not a `return` before its first `expect`.
 *
 * `if (!CHECKED_OUT) return;` as a test's first line made a clone without the private submodule report those tests
 * as passed, having checked nothing — and `multi-user-external.test.ts` records the time that hid a wrong path ("green
 * with the plugin deleted"). Skipped, a run says how much of it did not run.
 */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/** A test whose body opens with a guard that returns: `test("…", () => {\n  if (…) return;`. */
const GUARD_FIRST = /\b(?:test|it)(?:\.each\([\s\S]*?\))?\(\s*(["'`])(?:(?!\1).)*\1\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\n\s*if\s*\([^\n]*\)\s*return\s*;/g;

/** Every test file under `dir`. */
function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The Pro tests too, when the private submodule is checked out: they run in `bun run test` beside these, and a skip
 * by `return` there reads as a pass the same way. Not read before 0.7.11.
 */
const PRO = join(ROOT, "internals/pro");
const CHECKED_OUT = existsSync(join(PRO, "package.json"));

/** Every test file this guard reads. */
function guarded(): string[] {
  return [...testFiles(join(ROOT, "apps")), ...testFiles(join(ROOT, "packages")), ...testFiles(PRO)];
}

test("no test returns before its first assertion to stand in for a skip", () => {
  const offenders: string[] = [];
  for (const path of guarded()) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(GUARD_FIRST)) offenders.push(`${relative(ROOT, path)}:${source.slice(0, match.index).split("\n").length}`);
  }
  expect(offenders).toEqual([]);
});

test("the pattern finds the shape it is for", () => {
  expect('test("x", () => {\n    if (!CHECKED_OUT) return;\n    expect(1).toBe(1);\n  });'.match(GUARD_FIRST)).toHaveLength(1);
  expect('test("x", async () => {\n    const a = 1;\n    if (!a) return;\n  });'.match(GUARD_FIRST)).toBeNull();
});

test.skipIf(!CHECKED_OUT)("the Pro tests are read when they are checked out", () => {
  const pro = guarded().filter((path) => path.startsWith(PRO));
  expect(pro.length).toBeGreaterThanOrEqual(15);
  expect(pro.some((path) => path.includes("/appliance/tests/"))).toBe(true);
});
