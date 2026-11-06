/**
 * The connection started again after a stop — `src/connection.ts`.
 *
 * In the daemon the bridge is a module that stays loaded, and the gateway restarts a bridge that gave up with
 * `shutdown` and a new `hello`. `shutdown` set `stopping`, and `start` never cleared it, so the restarted bridge opened
 * nothing: live, WhatsApp took no message from an internet drop until the daemon restarted (2026-10-21).
 *
 * Run in its own process (`fixtures/restart.ts`): it stands Baileys in for the whole module graph.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-restart-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a bridge started after a stop opens a socket again", () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/restart.ts"), dir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.status).toBe(0);
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  const { first, total } = JSON.parse(last) as { first: number; total: number };
  expect(first).toBe(1);
  expect(total).toBe(2);
});
