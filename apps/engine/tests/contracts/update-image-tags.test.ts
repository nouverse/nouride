/**
 * The image a container is told to pull is one the release pushed.
 *
 * `nouride update` in a container printed `docker pull ghcr.io/nouverse/nouride:v0.7.10`, built from the release's
 * tag, and `release.yml` tags an image by the version — `0.7.10` and `0.7` — so the command a person copied failed with
 * `manifest unknown`, and so did the `docker run` and `kubectl set image` lines under it (the 0.7.7 → 0.7.10 upgrade
 * run). The tags here are read from the workflow's own `docker/metadata-action` patterns and its rows' package names,
 * and every image the hint names, for every edition that has one, is held to them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Edition } from "../../../../packages/update/src/edition.ts";
import { planUpdate } from "../../../../packages/update/src/plan.ts";

const WORKFLOW = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");

/** What `docker/metadata-action` pushes for a release tag, by the workflow's `type=semver` patterns. */
function pushedTags(tag: string): string[] {
  const block = WORKFLOW.slice(WORKFLOW.indexOf("          tags: |\n"), WORKFLOW.indexOf("          flavor: |"));
  const [major = "", minor = "", patch = ""] = tag.replace(/^v/, "").split(".");
  return [...block.matchAll(/type=semver,pattern=(\S+)/g)].map((m) =>
    m[1]!.replace("{{version}}", `${major}.${minor}.${patch}`).replace("{{major}}", major).replace("{{minor}}", minor),
  );
}

/** The workflow's rows that build an image: edition and package, `("pro", "--pro", "nouride-pro", "pro", …)`. */
function imageRows(): { edition: Edition; image: string }[] {
  const rows = [...WORKFLOW.matchAll(/^\s+\("[\w-]*",\s+"[^"]*",\s+"([\w-]+)",\s+"([\w-]+)",/gm)];
  return rows.map((m) => ({ edition: m[2] as Edition, image: `ghcr.io/nouverse/${m[1]}` }));
}

function containerPlan(edition: Edition, tag: string): string[] {
  const plan = planUpdate({
    tag,
    facts: {
      version: "0.7.7",
      edition,
      installDir: "/app",
      installDirWritable: true,
      supervisor: "docker",
      restartsOnExit: true,
      compiled: true,
      platform: "linux",
      arch: "arm64",
      musl: false,
    },
  });
  if (plan.can) throw new Error("a container never updates itself");
  return plan.instead;
}

describe("the image a container's update names", () => {
  test("the workflow pushes the version without its v, and its minor", () => {
    expect(pushedTags("v0.7.10")).toEqual(["0.7.10", "0.7"]);
    expect(imageRows().map((row) => row.edition)).toEqual(["basic", "router", "pro"]);
  });

  test("is the edition's own package, at a tag the release pushed — on every line that names one", () => {
    for (const { edition, image } of imageRows()) {
      const named = containerPlan(edition, "v0.7.10").flatMap((line) => [...line.matchAll(/ghcr\.io\/nouverse\/[\w-]+:\S+/g)].map((m) => m[0]));
      // docker pull, docker run, kubectl set image.
      expect(named.length).toBe(3);
      for (const ref of named) {
        const at = ref.lastIndexOf(":");
        expect(ref.slice(0, at)).toBe(image);
        expect(pushedTags("v0.7.10")).toContain(ref.slice(at + 1));
      }
    }
  });
});
