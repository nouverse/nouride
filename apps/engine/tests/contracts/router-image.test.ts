/**
 * `ghcr.io/nouverse/nouride-router`, now the free image under Router's name.
 *
 * Router became part of the free build, so there is no Router image to build — but compose files and `docker run`
 * lines out there pull that package, and one that stopped getting releases would keep every container on its version.
 * The public half of each release pushes the free image under it too, with one line added: `NOURIDE_IMAGE_MOVED_TO`,
 * which the dashboard reads to say where to pull from now on. Held here: the line is the only thing added, the image is
 * checked to be the free one before it is pushed, and the smoke that checks it fails an image that answers as anything
 * but `basic`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const ALIAS = readFileSync(join(ROOT, "scripts/release/router-image.Dockerfile"), "utf8");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/public-release.yml"), "utf8");
/** A step of the workflow, from its name to the next step or the end of its job. */
const step = (name: string) => {
  const at = WORKFLOW.indexOf(`- name: ${name}`);
  const ends = [WORKFLOW.indexOf("\n      - ", at + 1), WORKFLOW.indexOf("\n\n  ", at)].filter((end) => end > at);
  return WORKFLOW.slice(at, Math.min(...ends));
};

describe("the Router image", () => {
  test("is the image it is given, with the one line that says where it moved, and nothing else", () => {
    const instructions = ALIAS.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
    expect(instructions).toEqual(["ARG BASE", "FROM ${BASE}", "ENV NOURIDE_IMAGE_MOVED_TO=ghcr.io/nouverse/nouride"]);
    expect(ALIAS).toContain("0.9.0 removes this, and stops pushing `nouride-router` (v0.8.29_RFC).");
  });

  test("is built from the free image this run just pushed, held to it, and pushed under the same tag", () => {
    const build = step("Build and push");
    const alias = step("The Router image's name, for the Router containers out there");
    expect(WORKFLOW.indexOf("- name: Build and push")).toBeLessThan(WORKFLOW.indexOf("- name: The Router image's name"));
    expect(build).toContain('ref="ghcr.io/nouverse/nouride:${TAG#v}-${ARCH}"');
    expect(alias).toContain('base="ghcr.io/nouverse/nouride:${TAG#v}-${ARCH}"');
    expect(alias).toContain('ref="ghcr.io/nouverse/nouride-router:${TAG#v}-${ARCH}"');
    expect(alias).toContain('--build-arg "BASE=${base}" - < scripts/release/router-image.Dockerfile');
    // Checked before the push: the line is there, the bundle is the kit's, the label and the daemon say `basic`.
    for (const check of [
      'docker run --rm --entrypoint printenv "$ref" NOURIDE_IMAGE_MOVED_TO',
      'got=$(docker run --rm --entrypoint sha256sum "$ref" /app/nouride.bundle.js',
      '{{ index .Config.Labels "tech.nouverse.nouride.edition" }}',
      'sh scripts/release/image-smoke.sh "$ref" "${TAG#v}" basic',
    ]) {
      expect(alias.indexOf(check)).toBeGreaterThan(-1);
      expect(alias.indexOf(check)).toBeLessThan(alias.indexOf('docker push "$ref"'));
    }
    expect(WORKFLOW).toContain("it is held to that before it is pushed. 0.9.0 removes this (v0.8.29_RFC).");
  });

  test("gets the multi-arch tags the free image gets, and Router's tarballs are smoked as the free build", () => {
    const manifest = WORKFLOW.slice(WORKFLOW.indexOf("\n  manifest:"), WORKFLOW.indexOf("\n  publish:"));
    expect(manifest).toContain("edition: [basic, router]");
    expect(manifest).toContain('if [ "$EDITION" = basic ]; then pkg=nouride; else pkg="nouride-${EDITION}"; fi');
    expect(WORKFLOW).toContain("EDITION: ${{ matrix.edition == 'router' && 'basic' || matrix.edition }}");
  });
});

describe("image-smoke.sh", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nr-image-smoke-"));
    mkdirSync(join(dir, "bin"));
    // A `docker` that remembers what it was asked, and a `curl` that answers /health with what the test sets.
    writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh\necho "$*" >> "$CALLS"\ncase "$1" in run) echo cid ;; exec) echo "daemon running" ;; esac\n`, { mode: 0o755 });
    writeFileSync(join(dir, "bin", "curl"), '#!/bin/sh\nprintf %s "$HEALTH"\n', { mode: 0o755 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const smoke = (health: string) => {
    const calls = join(dir, `calls-${Math.random()}`);
    writeFileSync(calls, "");
    const run = spawnSync("sh", [join(ROOT, "scripts/release/image-smoke.sh"), "img:0.8.29-amd64", "0.8.29", "basic"], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HEALTH: health, CALLS: calls },
    });
    return { status: run.status, out: run.stdout, calls: readFileSync(calls, "utf8") };
  };

  test("passes an image that answers as the version and edition it is held to, and asks its CLI too", () => {
    const run = smoke('{"status":"ok","version":"0.8.29","edition":"basic"}');
    expect(run.status).toBe(0);
    expect(run.out).toContain("smoke: img:0.8.29-amd64 ok (basic 0.8.29)");
    expect(run.calls).toMatch(/^exec smoke-\d+ nouride status$/m);
    // And the container is gone after, whatever happened.
    expect(run.calls).toMatch(/^rm -f smoke-\d+$/m);
  });

  test("fails an image that answers as another edition — a Router build where the free one should be", () => {
    const run = smoke('{"status":"ok","version":"0.8.29","edition":"router"}');
    expect(run.status).toBe(1);
    expect(run.out).toContain("::error::img:0.8.29-amd64 did not answer as basic 0.8.29");
    expect(run.calls).toMatch(/^rm -f smoke-\d+$/m);
  });

  test("fails an image of another version", () => {
    expect(smoke('{"status":"ok","version":"0.8.27","edition":"basic"}').status).toBe(1);
  });
});
