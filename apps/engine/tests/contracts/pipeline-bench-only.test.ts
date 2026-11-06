/**
 * A test builds a `Pipeline` through the bench (`tests/pipeline-bench.ts`), and nowhere else.
 *
 * Twenty test files once wired their own: config, registry, providers, stores, gateways, each by hand. A change to
 * the pipeline's dependencies was twenty edits, and a hand-built harness drifted from boot without a sign — most had no
 * inbox, no journal and a turn store on no event stream, so they tested a path no daemon runs (invariant 9). "Files
 * move onto it as they are touched" did not hold: four were edited after the bench landed and kept their own. This
 * keeps the next one from being written.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The repository root: `tests/contracts` → `tests` → `engine` → `apps` → the root. */
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
/** The one test file that may build a Pipeline. */
const BENCH = "apps/engine/tests/pipeline-bench.ts";
/** Where test code lives: the workspace members and the Pro tree. */
const SEARCHED = ["apps", "packages", "internals/pro"];

/** Whether this text constructs a Pipeline itself, however the call is spaced or typed. */
function buildsPipeline(text: string): boolean {
  return /\bnew\s+Pipeline\s*(<[^>]*>)?\s*\(/.test(text);
}

/** Every test file and test helper under `dir`: a `*.test.ts(x)`, or any TypeScript in a `tests` directory. */
function testFiles(dir: string, inTests = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path, inTests || entry.name === "tests"));
    else if (/\.tsx?$/.test(entry.name) && (inTests || /\.test\.tsx?$/.test(entry.name))) out.push(path);
  }
  return out;
}

describe("a test's Pipeline", () => {
  test("the check sees a construction in every spelling, and not a mention", () => {
    // Assembled, so this file does not hold the very text it refuses.
    const built = (rest: string) => `${"new"} ${rest}`;
    expect(buildsPipeline(`const pipeline = ${built("Pipeline({ config })")}`)).toBe(true);
    expect(buildsPipeline(`const p: Pipeline = ${built("Pipeline ({")}`)).toBe(true);
    expect(buildsPipeline(built(" Pipeline<Deps>(deps)"))).toBe(true);
    expect(buildsPipeline("approvals?: ConstructorParameters<typeof Pipeline>[0]['approvals']")).toBe(false);
    expect(buildsPipeline("import { Pipeline } from '@/modules/pipeline/index.ts'")).toBe(false);
  });

  test("is built by the bench and in no other test file", () => {
    const files = SEARCHED.flatMap((dir) => testFiles(join(ROOT, dir))).map((path) => relative(ROOT, path));
    // The search reaches the tests at all: the bench and this file are among them.
    expect(files).toContain(BENCH);
    expect(files).toContain("apps/engine/tests/contracts/pipeline-bench-only.test.ts");
    const building = files.filter((file) => file !== BENCH && buildsPipeline(readFileSync(join(ROOT, file), "utf8")));
    expect(building).toEqual([]);
  });
});
