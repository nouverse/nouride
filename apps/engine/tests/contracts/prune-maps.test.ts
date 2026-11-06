/**
 * How long a release's private maps stay on the internal release (`scripts/release/prune-maps.ts`): the ten newest,
 * anything out less than thirty days, and what is named with `--keep` — and nothing deleted unless `--apply` says so.
 *
 * Every tag adds about 400 MB of maps and nothing took them off. A map deleted by mistake is not brought back by the
 * next release, so the dry run is the default and is held to deleting nothing.
 */

import { describe, expect, test } from "bun:test";
import { main, prunePlan, type Gh, type ReleaseMaps } from "../../../../scripts/release/prune-maps.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-12-31T00:00:00Z");
const map = (name: string) => ({ name, size: 22 * 1024 * 1024 });

/** `count` releases, newest first, one a week apart, the newest out a day — each with two maps. */
function weekly(count: number): ReleaseMaps[] {
  return Array.from({ length: count }, (_, i) => ({
    tag: `v0.9.${count - 1 - i}`,
    publishedAt: new Date(NOW - DAY - i * 7 * DAY).toISOString(),
    maps: [map(`nouride-linux-x64.map`), map(`nouride-image.map`)],
  }));
}

describe("which releases keep their maps", () => {
  test("the ten newest whatever their age, then what came out in the last thirty days", () => {
    // Weekly, so the 10 newest span 64 days: the window adds nothing past the tenth, and the four after it go.
    const plan = prunePlan(weekly(14), { now: NOW });
    expect(plan.kept.map((release) => release.tag)).toEqual(Array.from({ length: 10 }, (_, i) => `v0.9.${13 - i}`));
    expect(plan.prune.map((release) => release.tag)).toEqual(["v0.9.0", "v0.9.1", "v0.9.2", "v0.9.3"]);
    expect(plan.prune[0]!.maps.map((m) => m.name)).toEqual(["nouride-linux-x64.map", "nouride-image.map"]);
  });

  test("past the ten newest, a release out less than thirty days still keeps them", () => {
    // Daily: fourteen releases in fourteen days, all inside the window.
    const daily = Array.from({ length: 14 }, (_, i) => ({ tag: `v0.9.${13 - i}`, publishedAt: new Date(NOW - (i + 1) * DAY).toISOString(), maps: [map("m.map")] }));
    const plan = prunePlan(daily, { now: NOW });
    expect(plan.prune).toEqual([]);
    expect(plan.kept.at(-1)).toEqual({ tag: "v0.9.0", why: "out 14 days, under 30" });
  });

  test("a version named with --keep stays, with or without its v", () => {
    const plan = prunePlan(weekly(14), { now: NOW, keep: ["v0.9.1", "0.9.3"] });
    expect(plan.prune.map((release) => release.tag)).toEqual(["v0.9.0", "v0.9.2"]);
    expect(plan.kept).toContainEqual({ tag: "v0.9.3", why: "named with --keep" });
  });

  test("newest is by version, not by when it was published — a late fix to an older line is not the newest", () => {
    // Eleven releases, all out of the window: v0.9.10 … v0.9.1 out 36 to 45 days, and v0.9.0 published last, 35 days
    // ago. By date v0.9.0 would be the newest and v0.9.1 would go; by version v0.9.0 is the one past the ten.
    const releases = Array.from({ length: 11 }, (_, i) => ({
      tag: `v0.9.${10 - i}`,
      publishedAt: new Date(NOW - (i === 10 ? 35 : 36 + i) * DAY).toISOString(),
      maps: [map("m.map")],
    }));
    expect(prunePlan(releases, { now: NOW }).prune.map((release) => release.tag)).toEqual(["v0.9.0"]);
  });

  test("a draft is never touched, and a release with no maps is not listed to prune", () => {
    const releases = weekly(12);
    releases[11] = { ...releases[11]!, maps: [] };
    releases.push({ tag: "v1.0.0", publishedAt: null, maps: [map("draft.map")] });
    const plan = prunePlan(releases, { now: NOW });
    expect(plan.prune.map((release) => release.tag)).toEqual(["v0.9.1"]);
    expect(plan.kept.map((release) => release.tag)).not.toContain("v1.0.0");
  });
});

describe("running it", () => {
  /** A `gh` that answers the listing with `releases` and records every other call. */
  function fakeGh(releases: ReleaseMaps[]): { gh: Gh; calls: string[][] } {
    const calls: string[][] = [];
    const gh: Gh = (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return { status: 0, stdout: `${releases.map((release) => JSON.stringify(release)).join("\n")}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { gh, calls };
  }
  const quiet = () => {};

  test("lists and deletes nothing without --apply", () => {
    const { gh, calls } = fakeGh(weekly(14));
    const said: string[] = [];
    expect(main([], gh, NOW, (line) => said.push(line))).toBe(0);
    expect(calls.filter((argv) => argv[0] !== "api")).toEqual([]);
    expect(said.join("\n")).toContain("prune  v0.9.0 — 2 map(s), 44 MB");
    expect(said.join("\n")).toContain("Nothing deleted");
  });

  test("with --apply deletes the maps it listed, and only those", () => {
    const { gh, calls } = fakeGh(weekly(14));
    expect(main(["--apply", "--keep", "v0.9.2"], gh, NOW, quiet)).toBe(0);
    const deleted = calls.filter((argv) => argv[0] === "release").map((argv) => `${argv[2]} ${argv[3]}`);
    expect(deleted).toEqual([
      "v0.9.0 nouride-linux-x64.map",
      "v0.9.0 nouride-image.map",
      "v0.9.1 nouride-linux-x64.map",
      "v0.9.1 nouride-image.map",
      "v0.9.3 nouride-linux-x64.map",
      "v0.9.3 nouride-image.map",
    ]);
    expect(calls.filter((argv) => argv[0] === "release").every((argv) => argv[1] === "delete-asset" && argv.includes("--yes"))).toBe(true);
  });

  test("a delete that fails is said, and the run ends non-zero", () => {
    const { gh: listing } = fakeGh(weekly(11));
    const gh: Gh = (argv) => (argv[0] === "release" ? { status: 1, stdout: "", stderr: "HTTP 404" } : listing(argv));
    const said: string[] = [];
    expect(main(["--apply"], gh, NOW, (line) => said.push(line))).toBe(1);
    expect(said).toContain("✗ v0.9.0 nouride-linux-x64.map: HTTP 404");
  });
});
