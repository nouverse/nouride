/**
 * The site's Astro pages are typechecked somewhere: `bun run lint:site` (`astro check`), in `verify` and in CI.
 *
 * `lint:types` leaves `apps/site` to Astro (`NOT_FOR_TSC`), and until 0.7.11 nothing ran Astro's check, so the six
 * pages and their components were typechecked by nothing. It is not in the commit hook for its cost — see
 * `lint-sources.ts` — which makes the two places it does run the ones to hold.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("the site's pages", () => {
  test("lint:site is astro check, with the checker installed", () => {
    expect(manifest.scripts["lint:site"]).toContain("astro check");
    const site = JSON.parse(read("apps/site/package.json")) as { devDependencies?: Record<string, string> };
    expect(site.devDependencies?.["@astrojs/check"]).toBeDefined();
  });

  test("verify runs it, and so does CI", () => {
    expect(manifest.scripts.verify).toContain("bun run lint:site");
    expect(read(".github/workflows/ci.yml")).toMatch(/^\s*- run: bun run lint:site$/m);
  });
});
