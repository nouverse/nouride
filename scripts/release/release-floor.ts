#!/usr/bin/env bun
/**
 * A release's upgrade floor, from its notes into its checksum files.
 *
 *   bun run scripts/release/release-floor.ts --tag v0.8.0 dist/CHECKSUMS
 *
 * 0.8.0 upgrades only from the last 0.7.x, and an install learns that from the release's checksum files:
 * `# nouride-min-version: 0.7.14`, a line every updater from 0.7.11 reads (`packages/update/src/floor.ts`, install.sh)
 * and every older one passes over. The release workflow's `binaries` job writes it into each checksum file it makes,
 * and the `sign` job signs the file with the line in it, so it cannot be taken off a signed release.
 *
 * ## Where the floor is declared: the notes' front matter
 *
 *   ---
 *   min-version: 0.7.14
 *   ---
 *
 * at the top of `docs/releases/<tag>.md`, rather than a file of its own. A release with a floor is one whose notes have
 * to say so — "0.8.0 upgrades from 0.7.14 only" leads them — so the number and the sentence that explains it are one
 * file, read in one review, from the tagged tree the workflow already reads the notes from. A separate file could carry
 * a floor the notes never mention, or notes could name one no file declares. The front matter is stripped from both
 * release pages (`release-notes.ts`). No front matter, or none of this key, is no floor — 0.7.11 sets none.
 *
 * Self-contained on purpose: `node:` only, so a test runs it on a fake release tree.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const FLOOR_KEY = "min-version";

/** A notes file read into its front matter's floor and the body the release pages show. Throws on a floor it cannot use. */
export function parseNotes(text: string): { floor: string | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { floor: null, body: text };
  let floor: string | null = null;
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "") continue;
    const field = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    // A key nobody reads is a floor somebody meant to set and misspelled (`min_version`): refused, not ignored.
    if (!field || field[1] !== FLOOR_KEY) throw new Error(`the notes' front matter says \`${line}\`; the one key it takes is \`${FLOOR_KEY}\``);
    if (!/^\d+\.\d+\.\d+$/.test(field[2]!)) throw new Error(`\`${FLOOR_KEY}: ${field[2]}\` is not a release version (0.7.14 — no v, no suffix)`);
    floor = field[2]!;
  }
  return { floor, body: text.slice(match[0].length).replace(/^\n+/, "") };
}

/** The checksum file with the floor line on top, or as it was when there is no floor. */
export function withFloorLine(sums: string, floor: string | null): string {
  if (floor === null) return sums;
  if (/^#\s*nouride-min-version:/m.test(sums)) throw new Error("this checksum file already declares a floor");
  return `# nouride-min-version: ${floor}\n${sums}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--tag");
  const tag = at === -1 ? "" : (args[at + 1] ?? "");
  const files = args.filter((_, i) => i !== at && i !== at + 1);
  if (!/^v\d+\.\d+\.\d+/.test(tag) || files.length === 0) {
    console.error("usage: release-floor.ts --tag vX.Y.Z <checksum file>...");
    process.exit(2);
  }
  const notes = join(ROOT, "docs/releases", `${tag}.md`);
  const { floor } = existsSync(notes) ? parseNotes(readFileSync(notes, "utf8")) : { floor: null };
  if (floor === null) {
    console.log(`${tag} declares no upgrade floor: its checksum files carry none`);
    return;
  }
  for (const file of files) {
    writeFileSync(resolve(file), withFloorLine(readFileSync(resolve(file), "utf8"), floor));
    console.log(`${file}: # nouride-min-version: ${floor}`);
  }
}

if (import.meta.main) main();
