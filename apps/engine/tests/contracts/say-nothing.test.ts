/**
 * How a system event lets an agent stay quiet: a reply of only ".", which the daemon drops (`commons/silence.ts`).
 *
 * "Reply with nothing at all" was wrong for a coding CLI, which asks its model again for visible output when a turn ends
 * empty — the person got a filler line where silence was asked for (msn_53b16d; Nexa, 2026-10-31).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SAY_NOTHING } from "@/commons/silence.ts";

const SRC = join(import.meta.dir, "../../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("letting an agent say nothing", () => {
  test("is a full stop the daemon drops — something a coding CLI can send", () => {
    expect(SAY_NOTHING).toBe('reply with only "." (it is not sent)');
  });

  test("no text an agent is given asks for an empty reply any more", () => {
    // Its own reason, in `silence.ts`, quotes the old words.
    const asking = sources(SRC).filter((path) => !path.endsWith("silence.ts") && /reply with nothing at all/i.test(readFileSync(path, "utf8")));
    expect(asking).toEqual([]);
  });
});
