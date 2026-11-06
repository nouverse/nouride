/**
 * Every image stage that builds TypeScript it did not write has the root tsconfig those sources extend.
 *
 * The dashboard's `ui-*` packages extend `tsconfig.base.json`, and so, since 0.7.9, do the private plugins' — and the
 * Pro image stopped at `Tsconfig not found /app/tsconfig.base.json` on the v0.7.9 tag: the stage that copies
 * `internals` had never copied it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/** Each `FROM … AS name` stage's lines, by name. */
function stages(dockerfile: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of dockerfile.split("\n")) {
    const from = /^FROM\s+\S+(?:\s+\S+)*\s+AS\s+(\S+)/i.exec(line) ?? /^FROM\s+(\S+)/i.exec(line);
    if (from) out.set(from[1]!, (current = []));
    else current?.push(line);
  }
  return out;
}

test("a stage that copies sources extending the root tsconfig copies the root tsconfig too", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const missing = [...stages(dockerfile)]
    .filter(([, lines]) => lines.some((line) => /^COPY\s+(internals|apps\/dashboard)\s/.test(line)))
    .filter(([, lines]) => !lines.some((line) => /^COPY\s+tsconfig\.base\.json\s/.test(line)))
    .map(([name]) => name);
  expect(missing).toEqual([]);
});
