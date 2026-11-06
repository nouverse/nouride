/**
 * The image keeps every piece of state under `/app/.nouride` — the one path the docs tell you to mount.
 *
 * Added after the Router image created `/app/data` as well. That is the standalone nougate image's
 * data directory, and nougate picked it whenever it existed, so the in-process gateway wrote its
 * accounts and providers there: outside the volume. `docker compose up` after a pull, or a Dokploy
 * redeploy, recreated the container and the gateway came back with a fresh admin and no providers,
 * on a box whose operator had mounted exactly what the docs said.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Every absolute `/app/...` directory the file creates or hands to the service user. */
function stateDirs(text: string): string[] {
  const dirs = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/\b(mkdir|chown)\b/.test(line)) continue;
    for (const match of line.matchAll(/\/app\/[\w./-]+/g)) dirs.add(match[0]);
  }
  return [...dirs];
}

/** The stages that end up in the image a person runs — the build stages' scratch paths are not state. */
function runtimeStages(dockerfile: string): string {
  const start = dockerfile.indexOf("AS runtime-base");
  expect(start).toBeGreaterThan(0);
  return dockerfile.slice(start);
}

describe("the image's state", () => {
  const sources = {
    Dockerfile: () => runtimeStages(read("Dockerfile")),
    "scripts/docker-entrypoint.sh": () => read("scripts/docker-entrypoint.sh"),
  };
  for (const [file, source] of Object.entries(sources)) {
    test(`${file} creates nothing outside /app/.nouride`, () => {
      const outside = stateDirs(source()).filter((dir) => dir !== "/app/.nouride" && !dir.startsWith("/app/.nouride/"));
      expect(outside).toEqual([]);
    });
  }
});
