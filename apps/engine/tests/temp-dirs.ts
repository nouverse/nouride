/**
 * The folders the tests make with `tempDir`, removed when the run ends (0.8.8).
 *
 * Each was made and left behind: the missions harness alone left two per call, 146 calls a run, and CI runs the suite
 * twice a push — 13 GB in the CI runner's `/tmp` by 2026-10-29, a disk full enough to fail CI, and a 512 MB `/tmp` on
 * the box filled within one run. `bunfig.toml` preloads this, so the `afterAll` below is the run's, after every file:
 * one in a helper a test imports holds for the first file that imports it, and node's exit events do not fire under
 * `bun test`.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nouride-${prefix}-`));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
