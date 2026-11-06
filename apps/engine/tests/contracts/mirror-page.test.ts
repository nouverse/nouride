/**
 * The public mirror's first page (REVIEW A1, PLAN §4.2): every updater before 0.8.18 reads thirty releases, newest by
 * date, and finds a stepping stone only there. Each release's floor needs a stone at or above it, below the release,
 * within the first twenty-five; the release audit and `publish.ts` stop a release that would push one off.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { floorOf, strandedFloors, type MirrorEntry } from "../../../../scripts/release/mirror-page.ts";

const entry = (tag: string, floor: string | null = null, prerelease = false): MirrorEntry => ({ tag, floor, prerelease });
/** The mirror as it stood on 2026-11-04, with 0.8.17 on top. */
const TODAY = [entry("v0.8.17", "0.8.0"), entry("v0.8.16", "0.8.0"), entry("v0.8.0", "0.7.28"), entry("v0.7.29"), entry("v0.6.7"), entry("v0.5.14"), entry("v0.4.8")];
/** `count` intermediate releases on top, each with the 0.8 floor. */
const newer = (count: number) => Array.from({ length: count }, (_, i) => entry(`v0.8.${100 + count - i}`, "0.8.0"));

describe("the mirror's first page", () => {
  test("as it stands, every floor has its stone", () => {
    expect(strandedFloors(TODAY)).toEqual([]);
  });

  test("a stone pushed past the twenty-fifth strands the installs below its floor", () => {
    // 0.7.29, 0.8.0's stone, at the 25th place (index 24): still in.
    expect(strandedFloors([...newer(21), ...TODAY])).toEqual([]);
    // One more release and it is the 26th.
    expect(strandedFloors([...newer(22), ...TODAY])).toEqual([
      "v0.8.0 upgrades only from 0.7.28, and no release from 0.7.28 up to it stands in the first 25 of the mirror's page: an install below 0.7.28 has no way there",
    ]);
  });

  test("a bridge deleted from the mirror is named", () => {
    const without = TODAY.filter((release) => release.tag !== "v0.7.29");
    expect(strandedFloors(without)).toHaveLength(1);
    expect(strandedFloors(without)[0]).toStartWith("v0.8.0 upgrades only from 0.7.28");
  });

  test("a pre-release takes a place but is no stone: the updaters skip it", () => {
    const quiet = TODAY.map((release) => (release.tag === "v0.7.29" ? { ...release, prerelease: true } : release));
    expect(strandedFloors(quiet)).toHaveLength(1);
  });

  test("a release's floor is read from its notes in this repository", () => {
    expect(floorOf("v0.8.17")).toBe("0.8.0");
    expect(floorOf("v0.8.0")).toBe("0.7.28");
    expect(floorOf("v0.4.8")).toBeNull();
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");

  test("checks the page with the release on top, before anything is published", () => {
    const check = workflow.indexOf('bun run scripts/release/mirror-page.ts --adding "${GITHUB_REF_NAME}"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("- name: Initialize releases if tagged"));
  });

  test("stops when the update gate cannot be told, instead of going green with no box offered the release (REVIEW B1)", () => {
    expect(workflow).toContain('error "NOUVERSE_RELEASE_TOKEN is not set, so the signed Pro editions cannot be published for boxes.');
    expect(workflow).not.toContain("::warning::NOUVERSE_RELEASE_TOKEN is not set");
  });
});

