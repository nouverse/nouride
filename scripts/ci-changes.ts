#!/usr/bin/env bun
/**
 * Whether a push needs the root helper's job: it changed `packages/isolation`, or the workflow that runs it.
 *
 * Every other job of a push runs whatever it changed: the lint and the contract tests read the documentation and the
 * site as they read code. A push whose files cannot be listed needs the helper's job: it is never skipped by a guess.
 *
 *   bun run scripts/ci-changes.ts <before> <after>     writes helper= to $GITHUB_OUTPUT
 */

export interface Needs {
  helper: boolean;
}

const HELPER = [/^packages\/isolation\//, /^\.github\/workflows\/ci\.yml$/];

/** What a push touching `paths` needs; `null` paths (not known) needs everything. */
export function needsOf(paths: string[] | null): Needs {
  if (paths === null || paths.length === 0) return { helper: true };
  return { helper: paths.some((path) => HELPER.some((rule) => rule.test(path))) };
}

/** The paths between two commits, from GitHub's compare; null when that cannot be said (a new branch, a force push). */
function changedPaths(before: string, after: string): string[] | null {
  if (!before || /^0+$/.test(before)) return null;
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const r = Bun.spawnSync(["gh", "api", `repos/${repo}/compare/${before}...${after}`, "--jq", "[.status, (.files | length), (.files[].filename)] | .[]"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const [status, count, ...files] = r.stdout.toString().trim().split("\n");
  // `ahead` is a plain push; anything else (diverged after a force push) is not a list of what this push changed.
  // GitHub lists at most 300 files: a longer list is cut, so it says nothing about the rest.
  if (status !== "ahead" || Number(count) >= 300 || files.length !== Number(count)) return null;
  return files;
}

if (import.meta.main) {
  const [before = "", after = ""] = process.argv.slice(2);
  const paths = changedPaths(before, after);
  const needs = needsOf(paths);
  console.log(paths === null ? "the changed files could not be listed: the helper's job runs" : `${paths.length} changed file(s)`);
  console.log(`helper=${needs.helper}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) await Bun.write(out, `${(await Bun.file(out).exists()) ? await Bun.file(out).text() : ""}helper=${needs.helper}\n`);
}
