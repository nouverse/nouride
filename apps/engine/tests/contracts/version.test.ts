/**
 * One version, and nowhere else.
 *
 * It lived in five places: `apps/engine/package.json`, the root `package.json`,
 * `apps/site/src/consts.mjs`, and hardcoded constants in `src/index.ts`,
 * `src/cli/version.ts` and `modules/web/health.ts`. Releasing `0.1.1` bumped two
 * of them, so the image shipped code that told `/health` and `nouride --version`
 * it was `0.1.0` — the two things an operator reads to find out what is running.
 *
 * The constants are gone; this fails if one comes back.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@/cli/version.ts";

const ROOT = new URL("../../../..", import.meta.url).pathname;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("the version", () => {
  test("is the one in apps/engine/package.json", () => {
    expect(VERSION).toBe((JSON.parse(read("apps/engine/package.json")) as { version: string }).version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("agrees with every manifest that states it", () => {
    // A release bumps one number; these are the files that must move with it,
    // and a mismatch is a release that lies about itself somewhere.
    expect((JSON.parse(read("package.json")) as { version: string }).version).toBe(VERSION);
    expect(read("apps/site/src/consts.mjs")).toContain(`export const VERSION = '${VERSION}';`);
  });

  test("is not hardcoded anywhere in the engine", () => {
    /**
     * The guard, and the reason this file exists.
     *
     * Any `VERSION = "1.2.3"` in the engine is a fourth copy waiting to go
     * stale. `cli/version.ts` is the one home and it derives the value rather
     * than stating it, so a literal there would fail this too.
     */
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(join(ROOT, rel), "utf8");
        // A semver literal assigned to something called VERSION.
        if (/VERSION\s*(:\s*string\s*)?=\s*["']\d+\.\d+\.\d+["']/.test(text)) offenders.push(rel);
      }
    };
    walk("apps/engine/src");
    expect(offenders).toEqual([]);
  });
});
