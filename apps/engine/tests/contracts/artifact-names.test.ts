/**
 * A release's artefact names are written in four places: the build (`scripts/targets.ts`), the updater that downloads
 * one (`packages/update/src/edition.ts`), `scripts/install.sh`, and the release workflow that writes the checksum files.
 * Each was pinned by its own literals and never compared with the others — and a suffix changed on one side downloads
 * a build that was never published, or a checksum file that is not there, while every test stays green.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactName as built, EDITIONS as BUILT, KNOWN_TARGETS } from "../../../../scripts/targets.ts";
import { artifactName as fetched, checksumName, EDITIONS as KNOWN, variantFor } from "../../../../packages/update/src/edition.ts";

const ROOT = join(import.meta.dir, "../../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * There are three editions, and the names they had before — `device`, `device-pro`, `cloud`, `pro-router`, and before
 * those `normal` and `device-nougate` — are read as nothing any more. install.sh's own block is run for each name: it
 * took the old ones as aliases until 0.7.11, and `pro-router` as `pro` until 0.8.0.
 */
describe("the editions", () => {
  test("are three, and these three", () => {
    expect([...BUILT]).toEqual(["basic", "router", "pro"]);
  });

  test("install.sh's --variant takes each of them, and refuses every other name, naming the four", () => {
    const install = read("scripts/install.sh");
    const block = install.slice(install.indexOf("# >>> editions\n"), install.indexOf("# <<< editions"));
    expect(block).toContain("case");
    const variant = (name: string) => {
      const run = spawnSync("sh", ["-c", `die() { echo "DIE: $*"; exit 1; }\nsay() { echo "SAY: $*"; }\nVARIANT="$1"\n${block}\nprintf 'VARIANT=%s' "$VARIANT"`, "sh", name], {
        encoding: "utf8",
      });
      return { name, status: run.status, said: run.stdout.trim() };
    };
    // What each edition becomes is what the artefact derivation reads: the infix, or none for `basic`.
    for (const edition of BUILT) expect(variant(edition)).toEqual({ name: edition, status: 0, said: `VARIANT=${variantFor(edition)}` });
    expect(variant("")).toEqual({ name: "", status: 0, said: "VARIANT=" });
    for (const name of ["device", "device-pro", "cloud", "pro-router", "normal", "device-nougate", "Pro", "community"]) {
      expect(variant(name)).toEqual({ name, status: 1, said: `DIE: unknown --variant: ${name} (the editions are basic, router and pro)` });
    }
  });
});

describe("a release's artefact names", () => {
  test("the updater knows the editions the build makes, and no others", () => {
    expect([...KNOWN]).toEqual([...BUILT]);
  });

  test("for every edition and target, the updater asks for the name the build gave the tarball", () => {
    for (const edition of BUILT) {
      for (const target of KNOWN_TARGETS) expect(fetched(edition, target)).toBe(built(edition, target));
    }
  });

  test("and so does install.sh — its own derivation, run for each", () => {
    const line = read("scripts/install.sh")
      .split("\n")
      .find((text) => text.includes('ARTIFACT="nouride-'));
    expect(line).toBeDefined();
    for (const edition of BUILT) {
      for (const target of KNOWN_TARGETS) {
        const run = spawnSync("sh", ["-c", `${line}\nprintf %s "$ARTIFACT"`], { env: { VARIANT: variantFor(edition), TARGET: target }, encoding: "utf8" });
        expect(`${edition} ${target}: ${run.stdout}`).toBe(`${edition} ${target}: ${built(edition, target)}`);
      }
    }
  });

  test("the checksum file the updater fetches is the one the release workflow writes for that edition", () => {
    const workflow = read(".github/workflows/release.yml");
    // The workflow's rows, by variant — the first field of each.
    const variants = [...workflow.matchAll(/^\s+\("([a-z-]*)",\s+"/gm)].map((match) => match[1]);
    expect(variants.sort()).toEqual(BUILT.map(variantFor).sort());
    // Its one naming rule: the variant after a dash, or nothing.
    expect(workflow).toContain(`name="CHECKSUMS\${{ matrix.variant && format('-{0}', matrix.variant) || '' }}"`);
    // A release is built by its own tag's workflow, so this one publishes this version's name: `CHECKSUMS` from 0.8.0
    // (`CHECKSUMS_RENAMED_IN`), which every updater from 0.7.21 asks a 0.8 release for. Published as `SHA256SUMS`, no
    // update to it could be verified; an older 0.7.x keeps its name, for the updaters that know no other.
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    for (const edition of BUILT) {
      const variant = variantFor(edition);
      expect(checksumName(edition, `v${version}`)).toBe(variant ? `CHECKSUMS-${variant}` : "CHECKSUMS");
      expect(checksumName(edition, "v0.7.21")).toBe(variant ? `SHA256SUMS-${variant}` : "SHA256SUMS");
    }
  });
});
