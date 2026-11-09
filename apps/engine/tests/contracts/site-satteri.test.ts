/**
 * The site declares `satteri`, at Starlight's range, so a fresh install builds it.
 *
 * Starlight's `<Steps>` and `<Tabs>` render through `satteri`, whose loader requires a native binding by name. Vite's
 * SSR build keeps a package out of the prerender bundle only when it resolves from the site itself; with Bun's
 * isolated linker `satteri` did not, so it was bundled, and its loader looked for the binding beside the bundle, where
 * nothing is linked. A fresh install's build stopped at `/en/docs/start/first-run` with "Cannot find native binding" —
 * and so did the site's deploy, since 0.7.10 took out the six `@bruits/satteri-*` the site used to list for that
 * reason. Declared, it stays external, and Node finds the binding beside `satteri` itself.
 *
 * Starlight's own range, so the copy the site resolves is the one Starlight was written against: a second copy would
 * be the one the bundle imports, whatever Starlight wants.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const site = JSON.parse(readFileSync(join(ROOT, "apps/site/package.json"), "utf8")) as { dependencies?: Record<string, string> };
const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");

/** What a package's lock entry says it depends on, `name@range` for each. */
function rangesOf(pkg: string): Record<string, string> {
  const entry = new RegExp(`"${pkg.replace("/", "\\/")}": \\["${pkg.replace("/", "\\/")}@[^"]+", "", \\{ "dependencies": \\{([^}]*)\\}`).exec(lock);
  expect(entry).not.toBeNull();
  return Object.fromEntries([...entry![1]!.matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
}

test("the site declares satteri at the range Starlight and Astro's markdown declare", () => {
  const starlight = rangesOf("@astrojs/starlight").satteri;
  expect(starlight).toBeDefined();
  expect(site.dependencies?.satteri).toBe(starlight);
  expect(rangesOf("@astrojs/markdown-satteri").satteri).toBe(starlight);
});

test("one copy is installed, so the bundle and Starlight share it", () => {
  expect([...lock.matchAll(/"(?:[^"]*\/)?satteri": \["satteri@/g)].length).toBe(1);
});
