/**
 * The upgrade floor: the version an install must have run before it may take a release.
 *
 * 0.8.0 upgrades only from the last 0.7.x, whose one start carries the data across — the database migrated, the vault
 * laid out, `config.toml` rewritten — and every release after it only from 0.8.0. Which version an install takes is
 * decided by the updater of the version it *runs*, so the floor is read here, in every 0.7.x from 0.7.11, before 0.8.0
 * exists. Nothing here names a version: a 0.7.x is stepped through the last 0.7.x and 0.8.0 the same way, one stone at
 * a time.
 *
 * A release declares it as one line of its checksum files, `# nouride-min-version: 0.7.14` — inside the bytes the
 * signature covers, so it cannot be removed from a signed release, and invisible to every older parser, which matches
 * exact tarball names (`checksumFor`; install.sh's awk). No line, no floor.
 *
 * When the newest release for this edition has a floor above this version, the check offers the stepping stone
 * instead: the newest release whose own floor this version meets. And the install refuses a release whose floor it
 * does not meet, read from the checksum file the signature has just vouched for, whatever the check said.
 */

import type { Release } from "./release.ts";
import { compareVersions, parseVersion } from "./version.ts";

const FLOOR_LINE = /^#[ \t]*nouride-min-version:[ \t]*(\S+)[ \t]*$/;

/** The floor a checksum file declares — the first `# nouride-min-version:` line's value — or null when it declares none. */
export function releaseFloor(checksums: string): string | null {
  for (const line of checksums.split("\n")) {
    const match = FLOOR_LINE.exec(line.replace(/\r$/, ""));
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Whether `version` may take a release whose floor is `floor`: at or above it. No floor is met by every version; a
 * floor this cannot read is met by none — a release that says something about who may take it, in a form this does not
 * understand, is not one to install on a guess.
 */
export function meetsFloor(version: string, floor: string | null): boolean {
  if (floor === null) return true;
  const have = parseVersion(version);
  const need = parseVersion(floor);
  return have !== null && need !== null && compareVersions(have, need) >= 0;
}

const bare = (tag: string) => tag.replace(/^v/, "");

/** What the CLI, the dashboard and an agent say: "update to 0.7.14 first; 0.8.0 needs it". */
export function floorMessage(blocked: string, needs: string, stone: string | null): string {
  if (stone === null) {
    return `update to ${bare(needs)} first; ${bare(blocked)} needs it, and no release this install can take now reaches it: install ${bare(needs)} by hand, start it once, then update`;
  }
  return bare(stone) === bare(needs)
    ? `update to ${bare(stone)} first; ${bare(blocked)} needs it`
    : `update to ${bare(stone)} first; ${bare(blocked)} needs ${bare(needs)} or later`;
}

/**
 * The newest of `candidates` (newest first) whose floor `current` meets, reading each one's checksum file through
 * `floorOf` — `undefined` for one whose file could not be read or does not cover this build, which is passed over.
 */
export async function steppingStone(
  candidates: readonly Release[],
  current: string,
  floorOf: (release: Release) => Promise<string | null | undefined>,
): Promise<Release | null> {
  for (const release of candidates) {
    const floor = await floorOf(release);
    if (floor !== undefined && meetsFloor(current, floor)) return release;
  }
  return null;
}
