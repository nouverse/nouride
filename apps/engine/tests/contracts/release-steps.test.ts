/**
 * Publishing a release moves the Pro repository's `main` to the pin the tag carries, as it moves this repository's.
 *
 * It was not in the steps, and `nouride-pro`'s `main` stayed at 0.7.8's pin while 0.7.9's and 0.7.10's lived only on
 * release branches. The line is read out of `docs/CONTRIBUTING.md` § Cutting a release and run as written, against
 * repositories made here: it moves the Pro `main` to the pin when that is a fast-forward, and is refused, leaving it
 * where it was, when it is not. The private runbook's copy of the steps carries the same line in the same place, and a
 * test in the Pro repository holds it there: a published file names no private document.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/** The publishing block: the first fenced block under `heading`, as lines of shell with their comments cut. */
function publishing(markdown: string, heading: RegExp): string[] {
  const section = markdown.slice(markdown.search(heading));
  const block = /```(?:bash|sh)\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

const PRO_LINE = 'git -C internals/pro push origin "$(git rev-parse main:internals/pro)":refs/heads/main';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const config = ["user.name=t", "user.email=t@example.invalid", "init.defaultBranch=main", "commit.gpgsign=false"].flatMap((pair) => ["-c", pair]);
  const run = spawnSync("git", [...config, ...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A Pro remote whose `main` is one commit behind a release branch, and a checkout of this repository pinning that branch. */
function release(): { pro: string; checkout: string; pin: string } {
  const dir = mkdtempSync(join(tmpdir(), "nr-release-steps-"));
  dirs.push(dir);
  const pro = join(dir, "pro.git");
  git(dir, "init", "--bare", pro);
  const work = join(dir, "pro-work");
  git(dir, "clone", "-q", pro, work);
  writeFileSync(join(work, "a"), "0.7.8\n");
  git(work, "add", "a");
  git(work, "commit", "-qm", "the last pin main has");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  writeFileSync(join(work, "a"), "0.7.11\n");
  git(work, "commit", "-qam", "this release's pin");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/releases/v0.7.11");

  const checkout = join(dir, "nouride");
  git(dir, "init", "-q", checkout);
  git(checkout, "clone", "-q", "-b", "releases/v0.7.11", pro, "internals/pro");
  git(checkout, "add", "internals/pro");
  git(checkout, "commit", "-qm", "the release pins pro");
  return { pro, checkout, pin: git(join(checkout, "internals/pro"), "rev-parse", "HEAD") };
}

const sh = (line: string, cwd: string) => spawnSync("sh", ["-c", line], { cwd, encoding: "utf8" });

describe("publishing a release", () => {
  const steps = publishing(readFileSync(join(ROOT, "docs/CONTRIBUTING.md"), "utf8"), /^## Cutting a release$/m);

  test("moves this repository's main, then the Pro repository's main to the pin, then tags", () => {
    const at = (pattern: RegExp) => steps.findIndex((line) => pattern.test(line));
    const order = [at(/git push origin main$/), steps.indexOf(PRO_LINE), at(/git push origin vX\.Y\.Z$/)];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the Pro line, run as written, moves that main to the pin", () => {
    const { pro, checkout, pin } = release();
    const ran = sh(PRO_LINE, checkout);
    expect(ran.status).toBe(0);
    expect(git(pro, "rev-parse", "refs/heads/main")).toBe(pin);
  });

  test("and is refused, leaving main where it was, when the pin is not ahead of it", () => {
    const { pro, checkout } = release();
    // Somebody committed to Pro's main after the branch was cut: moving it to the pin would drop that commit.
    const other = join(checkout, "..", "other");
    git(checkout, "clone", "-q", pro, other);
    writeFileSync(join(other, "b"), "on main only\n");
    git(other, "add", "b");
    git(other, "commit", "-qm", "on main only");
    git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
    const before = git(pro, "rev-parse", "refs/heads/main");
    expect(sh(PRO_LINE, checkout).status).not.toBe(0);
    expect(git(pro, "rev-parse", "refs/heads/main")).toBe(before);
  });
});
