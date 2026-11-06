#!/usr/bin/env bun
/**
 * Take the private source maps off the releases no install is likely to run any more — and only say so unless asked.
 *
 *   bun run scripts/release/prune-maps.ts                       # what would go, and why each release that stays stays
 *   bun run scripts/release/prune-maps.ts --keep v0.7.8,v0.7.9  # and keep these too
 *   bun run scripts/release/prune-maps.ts --apply               # delete what it listed
 *
 * Every release puts a map beside each tarball and each image on the internal release (`release.yml`): 16 binary maps
 * and 3 image maps of 21–22 MB each, about 400 MB a tag, and nothing ever took them off. A map is worth its weight
 * while the build it describes can still send in a crash for `bun run symbolize`.
 *
 * ## What is kept
 *
 * A release keeps its maps while any of these holds:
 *
 * - **It is one of the ten newest.** An install that updates at all runs one of them: Boxes take a release within
 *   days of its rollout, and the dashboard tells a free install about each one.
 * - **It came out in the last 30 days.** Nothing phones home, so which version a free install runs is not known; an
 *   install nobody updates is what a window in time is for. A month, not more: releases come days apart, so a longer
 *   window keeps tens of gigabytes for builds whose crash report is answered with "update first" — and a map pruned
 *   from 0.7.11 on can be built again from its tag (below).
 * - **It is named with `--keep`.** A version the Nouride Boxes page's Fleet still shows — a Box with automatic updates
 *   off — or that a pod still pins. Fleet is the one place that knows, so whoever runs this reads it first.
 *
 * Everything else loses its `.map` assets, and only those: the release, its tarballs, checksum files and signatures
 * stay. A pruned map is not gone for good. From 0.7.11 the same commit built anywhere is the same code
 * (`scripts/build/build-path.ts`), so building the tag again writes the map again; before 0.7.11, only at the path the
 * release was built at (`docs/CONTRIBUTING.md`).
 *
 * ## Why a person runs it
 *
 * The release workflow does not prune on its own: what is still installed is known only from Fleet, and a deleted
 * asset is not brought back by the next run. So this lists, and deletes only with `--apply`.
 */

import { INTERNAL_REPO } from "../symbolize.ts";

/** How many of the newest releases keep their maps whatever their age. */
const KEEP_NEWEST = 10;
/** How long a release keeps its maps after it came out. */
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReleaseMaps {
  tag: string;
  /** ISO time it was published; null for a draft, which is never touched. */
  publishedAt: string | null;
  maps: { name: string; size: number }[];
}

export interface PrunePlan {
  /** The releases whose maps go, oldest first, each with the maps it holds. */
  prune: { tag: string; maps: { name: string; size: number }[] }[];
  /** The releases that keep theirs, newest first, with the first reason that keeps each. */
  kept: { tag: string; why: string }[];
}

/** `v0.7.10` → [0, 7, 10]; anything else sorts as the oldest. */
function versionOf(tag: string): number[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [-1, -1, -1];
}

function newerFirst(a: ReleaseMaps, b: ReleaseMaps): number {
  const [x, y] = [versionOf(a.tag), versionOf(b.tag)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

/** What goes and what stays, by the three rules above. Pure: `now` and the lists are the caller's. */
export function prunePlan(releases: readonly ReleaseMaps[], options: { now: number; keep?: readonly string[] }): PrunePlan {
  const named = new Set((options.keep ?? []).map((tag) => (tag.startsWith("v") ? tag : `v${tag}`)));
  const published = releases.filter((release) => release.publishedAt !== null).sort(newerFirst);
  const plan: PrunePlan = { prune: [], kept: [] };
  for (const [index, release] of published.entries()) {
    const ageDays = (options.now - Date.parse(release.publishedAt!)) / DAY_MS;
    const why =
      index < KEEP_NEWEST
        ? `one of the ${KEEP_NEWEST} newest`
        : ageDays < KEEP_DAYS
          ? `out ${Math.floor(ageDays)} days, under ${KEEP_DAYS}`
          : named.has(release.tag)
            ? "named with --keep"
            : null;
    if (why) plan.kept.push({ tag: release.tag, why });
    else if (release.maps.length > 0) plan.prune.push({ tag: release.tag, maps: release.maps });
  }
  plan.prune.reverse();
  return plan;
}

/** How `gh` is run: argv in, status and output back. The tests stand in for it. */
export type Gh = (argv: string[]) => { status: number; stdout: string; stderr: string };

const gh: Gh = (argv) => {
  const proc = Bun.spawnSync(["gh", ...argv], { stdout: "pipe", stderr: "pipe" });
  return { status: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

/** Every release on the internal repository, drafts included, with the maps each holds — one paginated call. */
function listReleases(run: Gh): ReleaseMaps[] {
  const jq =
    '.[] | {tag: .tag_name, publishedAt: (if .draft then null else .published_at end), ' +
    'maps: [.assets[] | select(.name | endswith(".map")) | {name, size}]}';
  const result = run(["api", "--paginate", `repos/${INTERNAL_REPO}/releases?per_page=100`, "--jq", jq]);
  if (result.status !== 0) throw new Error(`gh api: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseMaps);
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Lists, and with `--apply` deletes. 0 when everything asked for was done, 1 when something failed. */
export function main(argv: readonly string[], run: Gh = gh, now: number = Date.now(), say: (line: string) => void = console.log): number {
  const keepAt = argv.indexOf("--keep");
  const keep = keepAt >= 0 ? (argv[keepAt + 1] ?? "").split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  const apply = argv.includes("--apply");
  const plan = prunePlan(listReleases(run), { now, keep });

  for (const { tag, why } of plan.kept) say(`keep   ${tag} — ${why}`);
  const total = plan.prune.reduce((sum, release) => sum + release.maps.reduce((bytes, map) => bytes + map.size, 0), 0);
  for (const { tag, maps } of plan.prune) say(`prune  ${tag} — ${maps.length} map(s), ${megabytes(maps.reduce((bytes, map) => bytes + map.size, 0))}`);
  if (plan.prune.length === 0) {
    say("nothing to prune");
    return 0;
  }
  if (!apply) {
    say(`\n${plan.prune.length} release(s), ${megabytes(total)} of maps. Nothing deleted: check Fleet for a version still on a Box, keep it with --keep, then run again with --apply.`);
    return 0;
  }
  let failed = 0;
  for (const { tag, maps } of plan.prune) {
    for (const { name } of maps) {
      const result = run(["release", "delete-asset", tag, name, "--repo", INTERNAL_REPO, "--yes"]);
      if (result.status === 0) continue;
      failed += 1;
      say(`✗ ${tag} ${name}: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
  }
  say(failed === 0 ? `\ndeleted the maps of ${plan.prune.length} release(s), ${megabytes(total)}` : `\n${failed} map(s) could not be deleted`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
