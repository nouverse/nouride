#!/usr/bin/env bun
/**
 * Cutting a release, the runbook's steps 5 and 6 as one command (REVIEW B1: about forty hand steps across four
 * repositories, `content/` left out of the runbook, and CI on `main` cancelled or red for a commit already green).
 *
 *   bun run scripts/release/publish.ts vX.Y.Z [--lts | --quiet] [--dry-run]
 *
 * It refuses, naming every reason at once, unless: the checkout is on the release's branch (`releases/vX.Y.Z`, or
 * `lts/<line>` for a long-term patch); the version files and the notes say this version; every tree is clean and
 * pushed; every submodule's pin is on its remote; each `main` can fast-forward to what the release pins (a long-term
 * patch leaves the mains alone); CI passed on the commit; the mirror's first page keeps every stepping stone with the
 * release on top (`mirror-page.ts`); and the tag does not exist. Then it fast-forwards the mains, tags the branch's
 * commit (annotated `[lts]` or `[quiet]` for those modes), pushes, and waits for the release run and the public half.
 * `--dry-run` stops after saying what it would run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { floorOf, strandedFloors, type MirrorEntry } from "./mirror-page.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const REPO = "nouverse/nouride";
const SUBMODULES = ["internals/pro", "internals/nougate", "content"] as const;

export type Mode = "ordinary" | "lts" | "quiet";

export interface PublishFacts {
  tag: string;
  mode: Mode;
  branch: string;
  /** `package.json`'s version, and whether `docs/releases/<tag>.md` exists. */
  version: string;
  notes: boolean;
  /** Paths with uncommitted changes, `<tree>: <path>`. */
  dirty: string[];
  /** The branch's commit, and the remote's for it (null when it was never pushed). */
  head: string;
  pushedHead: string | null;
  /** Per submodule: its pin, whether a remote branch holds it, and whether its `main` can fast-forward to it. */
  pins: { path: string; pin: string; onRemote: boolean; mainFastForwards: boolean }[];
  /** Whether this repository's `main` can fast-forward to `head`. */
  mainFastForwards: boolean;
  /** Whether `ci.yml` passed on `head`. */
  ciGreen: boolean;
  /** What the mirror's first page would say with the release on top. */
  stranded: string[];
  tagExists: boolean;
}

/** Every reason not to publish, at once: fixing one and running again to meet the next is how a release takes an hour. */
export function refusals(f: PublishFacts): string[] {
  const out: string[] = [];
  const version = f.tag.replace(/^v/, "");
  const branch = f.mode === "lts" ? /^lts\/\d+\.\d+$/ : new RegExp(`^releases/${f.tag.replace(/\./g, "\\.")}$`);
  if (!branch.test(f.branch)) out.push(`the checkout is on ${f.branch}, not ${f.mode === "lts" ? "a lts/<line> branch" : `releases/${f.tag}`}`);
  if (f.mode === "lts" && f.branch.startsWith("lts/") && !version.startsWith(`${f.branch.slice(4)}.`)) {
    out.push(`${f.tag} is not on the ${f.branch.slice(4)} line its branch is for`);
  }
  if (f.version !== version) out.push(`package.json says ${f.version}, not ${version}: run ./bump-version ${version}`);
  if (!f.notes) out.push(`docs/releases/${f.tag}.md is missing: the release pages are written from it`);
  for (const path of f.dirty) out.push(`uncommitted: ${path}`);
  if (f.pushedHead === null) out.push(`${f.branch} was never pushed`);
  else if (f.pushedHead !== f.head) out.push(`${f.branch} is not pushed as it stands (here ${f.head.slice(0, 8)}, the remote ${f.pushedHead.slice(0, 8)})`);
  for (const pin of f.pins) {
    if (!pin.onRemote) out.push(`${pin.path}'s pin ${pin.pin.slice(0, 8)} is on no branch of its remote: CI cannot clone it`);
    if (f.mode !== "lts" && !pin.mainFastForwards) out.push(`${pin.path}'s main cannot fast-forward to its pin ${pin.pin.slice(0, 8)}`);
  }
  if (f.mode !== "lts" && !f.mainFastForwards) out.push(`main cannot fast-forward to ${f.branch}: take what main has first (merge, never cherry-pick)`);
  if (!f.ciGreen) out.push(`ci.yml has not passed on ${f.head.slice(0, 8)}: wait for it, or push and wait`);
  for (const problem of f.stranded) out.push(`the mirror: ${problem}`);
  if (f.tagExists) out.push(`${f.tag} already exists`);
  return out;
}

/** What it would run, in order, once nothing refuses. */
export function plan(f: Pick<PublishFacts, "tag" | "mode" | "branch" | "pins">): string[] {
  const steps: string[] = [];
  if (f.mode !== "lts") {
    steps.push(`git fetch . ${f.branch}:main`, "git push origin main");
    for (const pin of f.pins) steps.push(`git -C ${pin.path} push origin ${pin.pin}:refs/heads/main`);
  }
  steps.push(f.mode === "ordinary" ? `git tag ${f.tag} ${f.branch}` : `git tag -a ${f.tag} -m "[${f.mode}]" ${f.branch}`, `git push origin ${f.tag}`);
  return steps;
}

/**
 * The paths `git status --porcelain` names in one tree, as `<tree>: <path>`, the submodules' own entries left to their
 * trees. Each line is two status letters, a space, the path: the leading space of an unstaged change is a column, so
 * the output is never trimmed at its start (a `.github/…` change was said as `github/…`).
 */
export function dirtyPaths(porcelain: string, tree: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .filter((path) => !SUBMODULES.some((submodule) => path === submodule))
    .map((path) => `${tree}: ${path}`);
}

function run(cmd: string, args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trimEnd() };
}
const git = (args: string[], cwd = ROOT) => run("git", args, cwd);

function gather(tag: string, mode: Mode): PublishFacts {
  git(["fetch", "-q", "origin"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const head = git(["rev-parse", "HEAD"]).out;
  const remote = git(["rev-parse", "--verify", "-q", `origin/${branch}`]);
  const dirty = [ROOT, ...SUBMODULES.map((path) => join(ROOT, path))].flatMap((tree) =>
    dirtyPaths(git(["status", "--porcelain"], tree).out, tree === ROOT ? "." : tree.slice(ROOT.length)),
  );
  const pins = SUBMODULES.map((path) => {
    const cwd = join(ROOT, path);
    git(["fetch", "-q", "origin"], cwd);
    const pin = git(["rev-parse", `HEAD:${path}`]).out;
    return {
      path,
      pin,
      onRemote: git(["branch", "-r", "--contains", pin], cwd).out.length > 0,
      mainFastForwards: git(["merge-base", "--is-ancestor", "origin/main", pin], cwd).ok,
    };
  });
  const runs = run("gh", ["api", `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${head}&per_page=20`, "--jq", "[.workflow_runs[].conclusion] | join(\" \")"]);
  const listed = run("curl", ["-fsS", "-H", "accept: application/vnd.github+json", "https://api.github.com/repos/nouverse/nouride/releases?per_page=30"]);
  const page: MirrorEntry[] = listed.ok
    ? (JSON.parse(listed.out) as { tag_name: string; draft?: boolean; prerelease?: boolean }[])
        .filter((entry) => !entry.draft)
        .map((entry) => ({ tag: entry.tag_name, floor: floorOf(entry.tag_name), prerelease: entry.prerelease === true }))
    : [];
  if (!page.some((entry) => entry.tag === tag)) page.unshift({ tag, floor: floorOf(tag), prerelease: mode === "quiet" });
  return {
    tag,
    mode,
    branch,
    version: (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version,
    notes: existsSync(join(ROOT, "docs/releases", `${tag}.md`)),
    dirty,
    head,
    pushedHead: remote.ok ? remote.out : null,
    pins,
    mainFastForwards: git(["merge-base", "--is-ancestor", "origin/main", head]).ok,
    ciGreen: runs.ok && runs.out.split(" ").includes("success"),
    stranded: listed.ok ? strandedFloors(page) : ["the mirror's page could not be read"],
    tagExists: git(["rev-parse", "--verify", "-q", `refs/tags/${tag}`]).ok || git(["ls-remote", "--exit-code", "origin", `refs/tags/${tag}`]).ok,
  };
}

/**
 * A run's state as `gh run view --json status,conclusion` says it (`completed success`): its outcome once it has one,
 * null while it runs or when nothing could be read. Pure.
 */
export function settledRun(view: string): "success" | "failure" | null {
  const [status, conclusion] = view.trim().split(/\s+/);
  if (status !== "completed") return null;
  return conclusion === "success" ? "success" : "failure";
}

/**
 * The newest run of a workflow for this tag, waited for: its conclusion, read from the run. A watch's own exit is not:
 * 0.8.18's publish said "release.yml: failure" because a TLS handshake to GitHub timed out under the watch, while the
 * run went on to build the release.
 */
function waitFor(repo: string, workflow: string, since: string): string {
  for (let i = 0; i < 360; i++) {
    const found = run("gh", ["run", "list", "-R", repo, "--workflow", workflow, "--limit", "5", "--json", "databaseId,createdAt", "--jq", `[.[] | select(.createdAt >= "${since}")][0].databaseId // empty`]);
    if (found.ok && found.out) {
      for (let tries = 0; tries < 720; tries++) {
        spawnSync("gh", ["run", "watch", found.out, "-R", repo, "--interval", "60"], { stdio: ["ignore", "ignore", "inherit"] });
        const view = run("gh", ["run", "view", found.out, "-R", repo, "--json", "status,conclusion", "--jq", '.status + " " + .conclusion']);
        const settled = settledRun(view.ok ? view.out : "");
        if (settled) return settled;
        spawnSync("sleep", ["10"]);
      }
      return "never finished";
    }
    spawnSync("sleep", ["10"]);
  }
  return "never started";
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error("usage: bun run scripts/release/publish.ts vX.Y.Z [--lts | --quiet] [--dry-run]");
    process.exit(2);
  }
  const mode: Mode = process.argv.includes("--lts") ? "lts" : process.argv.includes("--quiet") ? "quiet" : "ordinary";
  const facts = gather(tag, mode);
  const refused = refusals(facts);
  if (refused.length > 0) {
    console.error(`✗ ${tag} is not published:`);
    for (const reason of refused) console.error(`  - ${reason}`);
    process.exit(1);
  }
  const steps = plan(facts);
  console.log(`${tag}, ${mode}: every check passed. ${process.argv.includes("--dry-run") ? "It would run:" : "Running:"}`);
  for (const step of steps) console.log(`  ${step}`);
  if (process.argv.includes("--dry-run")) process.exit(0);
  const since = new Date().toISOString();
  for (const step of steps) {
    const [cmd, ...args] = step.match(/"[^"]*"|\S+/g)!.map((part) => part.replace(/^"|"$/g, ""));
    if (!run(cmd!, args).ok) {
      console.error(`✗ stopped at: ${step}`);
      process.exit(1);
    }
  }
  console.log("waiting for the release run…");
  const release = waitFor(REPO, "release.yml", since);
  console.log(`release.yml: ${release}`);
  const publicHalf = release === "success" ? waitFor(REPO, "public-release.yml", since) : "not started";
  console.log(`the public half: ${publicHalf}`);
  process.exit(release === "success" && publicHalf === "success" ? 0 : 1);
}
