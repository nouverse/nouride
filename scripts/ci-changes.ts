#!/usr/bin/env bun
/**
 * Which of CI's jobs a push needs (2026-11-06, the owner: "test only when code changes; docs and the site should not
 * wait on the suite").
 *
 *   code     the full jobs, `verify` and `verify-private`
 *   helper   the root helper's job: `packages/isolation`, or the workflow that runs it
 *   docs     the light job: `lint:check`, the site's `astro check`, and the contract tests, which are the only tests that
 *            read the documentation (links, image tags, em dashes, release notes)
 *
 * A path is documentation only when it is prose nothing runs: `docs/` but its contracts and `EVENTS.md` (the suite
 * reads them), the site but its `consts.mjs` (the version a tag is checked against), and Markdown at the root.
 * `content/` is code: a skill's text is what the model is sent. Anything it cannot tell, or a push whose files it
 * cannot list, is code: the full run is never skipped by a guess.
 *
 *   bun run scripts/ci-changes.ts <before> <after>     writes code=, helper=, docs= to $GITHUB_OUTPUT
 */

export interface Needs {
  code: boolean;
  helper: boolean;
  docs: boolean;
}

const DOCS = [
  /^docs\/(?!contracts\/|EVENTS\.md$)/,
  /^apps\/site\/(?!src\/consts\.mjs$)/,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];
const HELPER = [/^packages\/isolation\//, /^\.github\/workflows\/ci\.yml$/];

/** What a push touching `paths` needs; `null` paths (not known) needs everything. */
export function needsOf(paths: string[] | null): Needs {
  if (paths === null || paths.length === 0) return { code: true, helper: true, docs: true };
  const docs = paths.filter((path) => DOCS.some((rule) => rule.test(path)));
  return {
    code: docs.length < paths.length,
    helper: paths.some((path) => HELPER.some((rule) => rule.test(path))),
    docs: docs.length > 0,
  };
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
  console.log(paths === null ? "the changed files could not be listed: everything runs" : `${paths.length} changed file(s)`);
  console.log(`code=${needs.code} helper=${needs.helper} docs=${needs.docs}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) await Bun.write(out, `${(await Bun.file(out).exists()) ? await Bun.file(out).text() : ""}code=${needs.code}\nhelper=${needs.helper}\ndocs=${needs.docs}\n`);
}
