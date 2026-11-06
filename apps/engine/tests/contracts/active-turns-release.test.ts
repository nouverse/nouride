/**
 * A turn is let go through `releaseTurn` (`ActiveTurns`, which `TurnContext` extends), never by deleting it from
 * `activeTurns`.
 *
 * The delete alone frees the key but answers nobody waiting on it: `wakeForJob` waits with
 * `waitUntilFree` so a finished job's result enters the queue after the turn that started it is gone.
 * Chat turns were fixed to release first; cron turns still deleted (`job-turns.ts`), so a job started
 * in one woke into a wait that never ended. Twice is a class of bug, so this holds the whole tree.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../../src");
const OWNER = "modules/pipeline/active-turns.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

test("only the active-turn table deletes from activeTurns; everything else calls releaseTurn", () => {
  const offenders = sources(SRC)
    .map((path) => relative(SRC, path))
    .filter((path) => path !== OWNER)
    .filter((path) => /activeTurns\.delete\(/.test(readFileSync(join(SRC, path), "utf8")));
  expect(offenders).toEqual([]);
});

test("and the table is where the delete is — a rule over a file that does not hold it holds nothing", () => {
  expect(readFileSync(join(SRC, OWNER), "utf8")).toMatch(/activeTurns\.delete\(/);
});
