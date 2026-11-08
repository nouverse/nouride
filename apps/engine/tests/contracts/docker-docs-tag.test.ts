/**
 * Every page that tells a Docker user which image to run names the image the way `docker-compose.prod.yml` does: the
 * latest one, with no tag.
 *
 * From 0.7.11 to 0.7.20 the compose file followed `:0.7`, so no install would jump to 0.8.0 before its notes said how
 * to cross, and this test held every page to it. Everything moved to the latest image in 0.7.20: a fresh
 * install should start on the newest release, and one pulled with each release passes through the last 0.7.x anyway.
 * A page left on `:0.7` would now be the odd one out, so a tag on any of them fails here (DEPLOY.md § The upgrade floor
 * has what a container that missed the last 0.7.x does).
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SITE = join(ROOT, "apps/site/src/content/docs");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? pages(path) : /\.mdx?$/.test(name) ? [path] : [];
  });
}

/** A public image as a page writes it — the registry path, or the site's `@@DOCKER_IMAGE@@` token — and its tag, if any. */
const IMAGE = /(?:ghcr\.io\/nouverse\/nouride|@@DOCKER_IMAGE@@)(?:-router)?(?::([\w.-]+))?/g;

test("the compose file follows the latest image", () => {
  expect(readFileSync(join(ROOT, "docker-compose.prod.yml"), "utf8")).toMatch(/^\s*image: ghcr\.io\/nouverse\/nouride\s*$/m);
});

test("README, GETTING_STARTED, every site page and the front page name the public images without a tag", () => {
  const files = [
    join(ROOT, "README.md"),
    join(ROOT, "GETTING_STARTED.md"),
    join(ROOT, "apps/site/src/consts.mjs"),
    ...pages(SITE),
  ];
  const named = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(IMAGE)].map((m) => ({ file: relative(ROOT, file), tag: m[1] })),
  );
  expect(named.length).toBeGreaterThan(10);
  expect(named.filter((ref) => ref.tag !== undefined)).toEqual([]);
});
