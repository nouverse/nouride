#!/usr/bin/env bun
/**
 * The public mirror's first page, as every updater before 0.8.18 reads it (REVIEW A1, PLAN §4.2).
 *
 * Those updaters read one page, `releases?per_page=30`, newest by date, and look for a stepping stone only there. A
 * release with a floor (`min-version` in its notes) is reachable from below that floor only through a release on that
 * page at or above the floor and below it. Once that stone is pushed off the page, every install below the floor is
 * stranded, and an updater already installed cannot be patched. So each floor's stone has to stand within the first
 * twenty-five: five releases of room before the thirtieth, for the next intermediate releases to be deleted (D1).
 *
 * The page is read as those updaters read it, with no token: a draft is not on it, and a pre-release takes a place
 * but is no stone, since they skip it. The release being cut is put at the top first, as it will stand once published.
 *
 *   bun run scripts/release/mirror-page.ts [--adding vX.Y.Z]     exit 1, each stranded floor named, when one is
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNotes } from "./release-floor.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const PAGE_URL = "https://api.github.com/repos/nouverse/nouride/releases?per_page=30";
/** The stone's place may be at most this (zero-based below it): the first twenty-five of thirty. */
export const STONE_WITHIN = 25;

export interface MirrorEntry {
  tag: string;
  /** Its `min-version`, from its notes; null when it has none. */
  floor: string | null;
  prerelease: boolean;
}

function parts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: string, b: string): number | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Each release on the page whose floor has no stone within `within`, said as the problem it is. */
export function strandedFloors(page: MirrorEntry[], within = STONE_WITHIN): string[] {
  const problems: string[] = [];
  for (const release of page) {
    if (!release.floor) continue;
    const floor = release.floor;
    const stone = page.findIndex(
      (candidate, place) =>
        place < within &&
        !candidate.prerelease &&
        (compare(candidate.tag, floor) ?? -1) >= 0 &&
        (compare(candidate.tag, release.tag) ?? 1) < 0,
    );
    if (stone === -1) {
      problems.push(
        `${release.tag} upgrades only from ${floor}, and no release from ${floor} up to it stands in the first ${within} of the mirror's page: an install below ${floor} has no way there`,
      );
    }
  }
  return problems;
}

/** A release's floor, from its notes in this repository; null for a release with none, or no notes here. */
export function floorOf(tag: string, root = ROOT): string | null {
  const path = join(root, "docs/releases", `${tag}.md`);
  return existsSync(path) ? parseNotes(readFileSync(path, "utf8")).floor : null;
}

if (import.meta.main) {
  const adding = (() => {
    const at = process.argv.indexOf("--adding");
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })();
  // No token, on purpose: the page as an updater in the field sees it.
  const response = await fetch(PAGE_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "nouride-release-audit" } });
  if (!response.ok) {
    console.error(`✗ the mirror's page answered ${response.status} (${PAGE_URL})`);
    process.exit(1);
  }
  const listed = (await response.json()) as { tag_name: string; draft?: boolean; prerelease?: boolean }[];
  const page: MirrorEntry[] = listed
    .filter((entry) => !entry.draft)
    .map((entry) => ({ tag: entry.tag_name, floor: floorOf(entry.tag_name), prerelease: entry.prerelease === true }));
  if (adding && !page.some((entry) => entry.tag === adding)) page.unshift({ tag: adding, floor: floorOf(adding), prerelease: false });
  const problems = strandedFloors(page);
  for (const [place, entry] of page.entries()) {
    console.log(`  ${String(place + 1).padStart(2)}  ${entry.tag}${entry.floor ? `  (from ${entry.floor})` : ""}${entry.prerelease ? "  pre-release" : ""}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log(`✓ every floor on the mirror's first page has its stepping stone within the first ${STONE_WITHIN}`);
}
