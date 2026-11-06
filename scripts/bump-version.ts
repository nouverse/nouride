#!/usr/bin/env bun
/**
 * Set the product version, everywhere it is written down.
 *
 *     ./bump-version 0.5.2
 *     ./bump-version 0.6.0-rc.1 --dry-run
 *
 * ## Why this exists
 *
 * The version lives in four files and every release has been four manual edits. Two of them are
 * `package.json` and the others are not, which is exactly the kind that gets forgotten: `apps/site` is
 * built separately and a stale constant there ships a download page advertising the previous
 * release. Nothing fails when that happens — the site is simply wrong until somebody notices. The
 * fourth is `bun.lock`'s copy of the engine's version, which `bun install --frozen-lockfile` accepts
 * stale and a plain `bun install` rewrites, leaving a diff in whoever's checkout runs it next.
 *
 * ## What it does not touch
 *
 * Every other `package.json` in the repository sits at `0.1.0` and is meant to. Those are workspace
 * members — `@nouride/shared`, `@nouride/policy`, the dashboard — that are never published and never
 * versioned independently; bumping them would be noise in every release diff and would imply a
 * compatibility promise between packages that only ever ship together.
 *
 * The submodules under `internals/` carry their own versions on purpose. They are separate
 * repositories with separate releases, and `packages/wa-bridge` has its own licence to go with it.
 *
 * ## What it refuses
 *
 * **A version that is not ahead of the current one.** A bump that quietly does nothing is how a tag
 * ends up on the wrong commit: the release script reads `package.json`, gets the old number, and
 * builds the previous release under the new name.
 *
 * **Files that already disagree.** If the four are not on the same version, the repository is in a
 * state a blind replace would paper over — so it says which file is out of step and stops. Pass
 * `--force` once you know why.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The repository root, relative to this file. Not the working directory: this runs from anywhere. */
const ROOT = join(import.meta.dir, "..");

interface Target {
  path: string;
  /**
   * Matches the whole assignment, with the version itself as group 1.
   *
   * A regex rather than `JSON.parse` + `stringify` for the two manifests: re-serialising a
   * `package.json` reformats every line that bun's own writer would have written differently, and a
   * release diff is not the place to discover that.
   */
  pattern: RegExp;
  /** Said out loud in the output, so a reader can tell whether the list is still right. */
  why: string;
}

const TARGETS: Target[] = [
  {
    path: "package.json",
    pattern: /^(\s*"version":\s*")([^"]+)(")/m,
    why: "the workspace root — what `bun run` and the release workflow read",
  },
  {
    path: "apps/engine/package.json",
    pattern: /^(\s*"version":\s*")([^"]+)(")/m,
    why: "the daemon — what `/health` and `nouride --version` report",
  },
  {
    path: "apps/site/src/consts.mjs",
    pattern: /^(export const VERSION = ')([^']+)(')/m,
    why: "the download page — built separately, so a stale number here ships silently",
  },
  {
    // The engine's own entry, not the first "version" in the file: the lock lists every workspace member.
    path: "bun.lock",
    pattern: /^(\s*"apps\/engine": \{\s*"name": "@nouride\/engine",\s*"version": ")([^"]+)(")/m,
    why: "the lockfile's copy of the daemon's — left behind by 0.7.11's bump, and a plain `bun install` rewrites it",
  },
];

/** `1.2.3`, with an optional pre-release tail. Build metadata is deliberately not accepted. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

function parse(version: string): Parsed | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { pre: match[4] } : {}),
  };
}

/**
 * Negative when `a` is older, positive when newer, zero when the same.
 *
 * A pre-release sorts *before* the release it leads to — `0.6.0-rc.1` is older than `0.6.0` — which
 * is the rule that makes `0.6.0-rc.1 → 0.6.0` a legal bump rather than a refusal.
 */
function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function read(target: Target): { text: string; current: string } {
  const full = join(ROOT, target.path);
  const text = readFileSync(full, "utf8");
  const match = target.pattern.exec(text);
  if (!match) {
    fail(
      `${target.path} has no version line this script recognises.`,
      "Either the file moved or its shape changed — fix `TARGETS` in scripts/bump-version.ts.",
    );
  }
  return { text, current: match![2]! };
}

function fail(...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const [next] = args.filter((arg) => !arg.startsWith("--"));

  if (!next) {
    fail(
      "Usage: ./bump-version <version> [--dry-run] [--force]",
      "",
      "  ./bump-version 0.5.2",
      "  ./bump-version 0.6.0-rc.1 --dry-run",
    );
  }

  const parsedNext = parse(next);
  if (!parsedNext) fail(`"${next}" is not a version. Expected x.y.z, optionally with -pre.`);

  const files = TARGETS.map((target) => ({ target, ...read(target) }));

  // Every file's current version, so a disagreement is reported rather than erased.
  const currents = [...new Set(files.map((file) => file.current))];
  if (currents.length > 1 && !force) {
    fail(
      "These files are not on the same version, so there is nothing to bump *from*:",
      ...files.map((file) => `  ${file.current.padEnd(14)} ${file.target.path}`),
      "",
      "Put them back in step, or pass --force if you know why they differ.",
    );
  }

  const current = files[0]!.current;
  const parsedCurrent = parse(current);
  if (parsedCurrent && compare(parsedNext, parsedCurrent) <= 0 && !force) {
    fail(
      `${next} is not ahead of ${current}.`,
      "A bump that changes nothing is how a tag lands on the wrong commit: the release workflow",
      "reads package.json, gets the old number, and builds the previous release under the new name.",
      "",
      "Pass --force if you meant it.",
    );
  }

  console.log(`${current}  →  ${next}${dryRun ? "   (dry run — nothing written)" : ""}\n`);
  for (const file of files) {
    // `$1`/`$3` keep the exact indentation and quote style the file already had.
    const updated = file.text.replace(file.target.pattern, `$1${next}$3`);
    if (!dryRun) writeFileSync(join(ROOT, file.target.path), updated);
    console.log(`  ${file.target.path}`);
    console.log(`    ${file.target.why}`);
  }

  if (dryRun) return;
  console.log("");
  console.log("Next:");
  console.log("  bun run verify");
  console.log(`  git commit -am "chore(release): v${next}"`);
  console.log(`  git tag v${next} && git push && git push --tags`);
}

main();
