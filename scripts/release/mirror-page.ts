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
 * The page is the one those updaters read: a draft is left out, as they never see one, and a pre-release takes a place
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

/** A refusal GitHub gives a caller that asked too often: asked again after a wait, never read as the page. */
const ASKED_TOO_OFTEN = new Set([403, 429]);

/**
 * The page's releases, read with the workflow's token where there is one. With no token, GitHub allows sixty asks an
 * hour from one address, and a hosted runner shares its address with other repositories' jobs: v0.8.36's release
 * stopped here on a 403 that was that limit, while the page answered anyone else. A token reads the same public page,
 * drafts included, which are left out below as the updaters never see them. A refusal for asking too often is asked
 * again, twice, after the wait GitHub names or a few seconds; any other answer is the page's.
 */
export async function readPage(options: { token?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ ok: true; listed: { tag_name: string; draft?: boolean; prerelease?: boolean }[] } | { ok: false; status: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "nouride-release-audit" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await doFetch(PAGE_URL, { headers });
    if (response.ok) return { ok: true, listed: (await response.json()) as { tag_name: string; draft?: boolean; prerelease?: boolean }[] };
    status = response.status;
    if (!ASKED_TOO_OFTEN.has(status) || attempt === 2) break;
    const asked = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(asked) && asked > 0 ? Math.min(asked, 60) * 1000 : 5_000 * (attempt + 1));
  }
  return { ok: false, status };
}

if (import.meta.main) {
  const adding = (() => {
    const at = process.argv.indexOf("--adding");
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })();
  const read = await readPage({ token: process.env.GH_TOKEN || undefined });
  if (!read.ok) {
    console.error(`✗ the mirror's page answered ${read.status} (${PAGE_URL})`);
    process.exit(1);
  }
  const listed = read.listed;
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
