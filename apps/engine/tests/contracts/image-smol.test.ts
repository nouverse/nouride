/**
 * How the image runs its bundle: with `--smol`, as the compiled binary does (E8), and with `--no-install`.
 *
 * The release binary has `--smol` in its execArgv and the image started the bundle with plain `bun run`, so the
 * container — the shape most likely to run under a memory cap — ran the larger heap: about 29 % more at peak.
 *
 * And `/app` has no node_modules, where Bun installs from npm any package an import names that nothing resolves —
 * checked against `oven/bun:1.4-alpine`: `import("is-odd")` resolved there with no install step, and failed with
 * `--no-install`. Every plugin an edition leaves out is imported by a name nobody owns on npm (`nouride-oauth` on each
 * boot), so the free image would have run whatever someone published under it. A compiled binary does not do this.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

test("the image starts the daemon with --smol and --no-install, before `run` where bun reads its own flags", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const cmd = /^CMD (\[.*\])$/m.exec(dockerfile)?.[1];
  expect(cmd).toBeDefined();
  expect(JSON.parse(cmd!)).toEqual(["bun", "--smol", "--no-install", "run", "nouride.bundle.js", "start"]);
});

test("and the CLI on its PATH runs the same bundle the same way, as root and as the daemon's account", () => {
  const wrapper = readFileSync(join(ROOT, "scripts/docker-nouride.sh"), "utf8");
  const runs = [...wrapper.matchAll(/^\s*exec .*\bbun\b.*$/gm)].map((match) => match[0].trim());
  expect(runs).toEqual([
    'exec su-exec bun bun --no-install /app/nouride.bundle.js "$@"',
    'exec bun --no-install /app/nouride.bundle.js "$@"',
  ]);
});
