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
 * release on top (`mirror-page.ts`); and the tag does not exist. Then, the order since 0.8.36: it opens the pull request
 * from the release branch to `main` (or takes the one open), waits for its checks, merges it with a merge commit,
 * deletes the branch, asks for `ci.yml` on the merge commit and waits for it to end green, moves the submodules' `main`
 * to their pins, tags the merge commit (annotated `[quiet]` for a quiet release) and waits for the release run and the
 * public half. A long-term patch has no pull request: its `lts/` branch's commit is tagged `[lts]`. A red check stops it
 * with nothing merged; a new commit on the branch and the same command again take the same pull request. `--dry-run`
 * stops after saying what it would run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { floorOf, strandedFloors, type MirrorEntry } from "./mirror-page.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const REPO = "nouverse/nouride";
/** Where the Pro half of a release runs, since the main repository went public (2026-11-06). */
const PRO_REPO = "nouverse/nouride-pro";
const SUBMODULES = ["internals/pro", "internals/nougate"] as const;

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

/** What it would run, in order, once nothing refuses: what `--dry-run` says. `<n>` and `<merge>` are read as it goes. */
export function plan(f: Pick<PublishFacts, "tag" | "mode" | "branch" | "pins">): string[] {
  if (f.mode === "lts") return [`git tag -a ${f.tag} -m "[lts]" ${f.branch}`, `git push origin ${f.tag}`];
  return [
    `gh pr create --repo ${REPO} --base main --head ${f.branch} --title ${f.tag} --body-file docs/releases/${f.tag}.md (or the one open)`,
    `gh pr checks <n> --repo ${REPO}, until every check has ended, all green`,
    `gh pr merge <n> --repo ${REPO} --merge`,
    `git push origin --delete ${f.branch}`,
    `gh workflow run ci.yml --repo ${REPO} --ref main, until its run on <merge> has ended green`,
    ...f.pins.map((pin) => `git -C ${pin.path} push origin ${pin.pin}:refs/heads/main`),
    tagLine(f, "<merge>"),
    `git push origin ${f.tag}`,
  ];
}

function tagLine(f: Pick<PublishFacts, "tag" | "mode">, at: string): string {
  return f.mode === "ordinary" ? `git tag ${f.tag} ${at}` : `git tag -a ${f.tag} -m "[${f.mode}]" ${at}`;
}

/** How publishing reaches git, `gh` and the clock: the machine's own, or a test's stand-ins. */
export interface PublishIo {
  run: (cmd: string, args: string[]) => { ok: boolean; out: string };
  sleep: (ms: number) => void;
  say: (line: string) => void;
}

/**
 * The checks of a pull request as `gh pr checks` prints them, a line each (`name<TAB>state<TAB>…`): green once every
 * one has ended and none failed, red once one failed or was cancelled, null while any runs or none is listed yet (a
 * pull request just opened has none for a few seconds). Pure.
 */
export function settledChecks(printed: string): "pass" | "fail" | null {
  const states = printed.split("\n").map((line) => line.split("\t")[1]?.trim() ?? "").filter(Boolean);
  if (states.some((state) => state === "fail" || state === "cancel")) return "fail";
  if (states.length === 0 || states.some((state) => state === "pending")) return null;
  return "pass";
}

/** The number at the end of a pull request's address, as `gh pr create` prints it. */
function prNumber(out: string): string {
  return /\/pull\/(\d+)\s*$/.exec(out.trim())?.[1] ?? "";
}

/**
 * Publish an ordinary or quiet release through its pull request, or tag a long-term patch: the steps `plan` names, run.
 * Stops at the first that fails, saying which; nothing after it runs. Returns the commit tagged, or null when it stopped.
 */
export function publish(f: PublishFacts, io: PublishIo): string | null {
  const step = (cmd: string, ...args: string[]) => {
    const done = io.run(cmd, args);
    if (!done.ok) io.say(`✗ stopped at: ${[cmd, ...args].join(" ")}`);
    return done;
  };
  if (f.mode === "lts") {
    if (!step("git", "tag", "-a", f.tag, "-m", "[lts]", f.branch).ok || !step("git", "push", "origin", f.tag).ok) return null;
    return f.head;
  }

  const open = io.run("gh", ["pr", "list", "--repo", REPO, "--base", "main", "--head", f.branch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
  let pr = open.ok ? open.out.trim() : "";
  if (pr) io.say(`the pull request open for ${f.branch}: #${pr}`);
  else {
    const made = step("gh", "pr", "create", "--repo", REPO, "--base", "main", "--head", f.branch, "--title", f.tag, "--body-file", `docs/releases/${f.tag}.md`);
    pr = made.ok ? prNumber(made.out) : "";
    if (!pr) return null;
    io.say(`opened #${pr}`);
  }

  // Up to three hours: the whole suite runs on the pull request, behind whatever else the runners have.
  let checks: "pass" | "fail" | null = null;
  for (let i = 0; i < 360 && checks === null; i++) {
    if (i > 0) io.sleep(30_000);
    checks = settledChecks(io.run("gh", ["pr", "checks", pr, "--repo", REPO]).out);
  }
  if (checks !== "pass") {
    io.say(checks === "fail" ? `✗ a check of #${pr} failed: nothing is merged. Fix it with a new commit on ${f.branch}, then run this again.` : `✗ the checks of #${pr} never ended`);
    return null;
  }

  if (!step("gh", "pr", "merge", pr, "--repo", REPO, "--merge").ok) return null;
  const merge = io.run("gh", ["pr", "view", pr, "--repo", REPO, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]).out.trim();
  if (!/^[0-9a-f]{40}$/.test(merge)) {
    io.say(`✗ #${pr} was merged, and its merge commit could not be read: tag it by hand (the runbook's step 5)`);
    return null;
  }
  // The repository does not delete a merged branch itself.
  if (!step("git", "push", "origin", "--delete", f.branch).ok) return null;

  // The merge commit is one no suite ran on: a tag pushed while that run works builds with its own and was red twice.
  const since = isoNow();
  if (!step("gh", "workflow", "run", "ci.yml", "--repo", REPO, "--ref", "main").ok) return null;
  const suite = waitFor(io, REPO, "ci.yml", since, merge);
  if (suite !== "success") {
    io.say(`✗ ci.yml on the merge commit ${merge.slice(0, 8)}: ${suite}. Nothing is tagged.`);
    return null;
  }

  step("git", "fetch", "-q", "origin");
  for (const pin of f.pins) if (!step("git", "-C", pin.path, "push", "origin", `${pin.pin}:refs/heads/main`).ok) return null;
  const tag = f.mode === "ordinary" ? ["tag", f.tag, merge] : ["tag", "-a", f.tag, "-m", `[${f.mode}]`, merge];
  if (!step("git", ...tag).ok || !step("git", "push", "origin", f.tag).ok) return null;
  return merge;
}

/** Now, as GitHub writes a run's `createdAt`. A function so a test can read the order of the calls rather than a time. */
const isoNow = () => new Date().toISOString();

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

/**
 * A command's answer, whole. The buffer is set: the default holds 1 MiB and a command past it reads as failed, which is
 * how the public list of releases, 1.09 MB with thirty releases' notes in it, became "the mirror's page could not be
 * read".
 */
export function run(cmd: string, args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
 * The newest run of a workflow started since `since` (on `sha` when one is named), waited for: its conclusion, read
 * from the run. A watch's own exit is not: 0.8.18's publish said "release.yml: failure" because a TLS handshake to
 * GitHub timed out under the watch, while the run went on to build the release.
 */
function waitFor(io: PublishIo, repo: string, workflow: string, since: string, sha?: string): string {
  const which = `[.[] | select(.createdAt >= "${since}")${sha ? ` | select(.headSha == "${sha}")` : ""}][0].databaseId // empty`;
  for (let i = 0; i < 360; i++) {
    const found = io.run("gh", ["run", "list", "-R", repo, "--workflow", workflow, "--limit", "10", "--json", "databaseId,createdAt,headSha", "--jq", which]);
    if (found.ok && found.out) {
      for (let tries = 0; tries < 720; tries++) {
        const view = io.run("gh", ["run", "view", found.out, "-R", repo, "--json", "status,conclusion", "--jq", '.status + " " + .conclusion']);
        const settled = settledRun(view.ok ? view.out : "");
        if (settled) return settled;
        io.sleep(30_000);
      }
      return "never finished";
    }
    io.sleep(10_000);
  }
  return "never started";
}

const MACHINE: PublishIo = {
  run: (cmd, args) => run(cmd, args),
  sleep: (ms) => void spawnSync("sleep", [String(ms / 1000)]),
  say: (line) => console.log(line),
};

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
  const since = isoNow();
  if (publish(facts, MACHINE) === null) process.exit(1);
  console.log("waiting for the release run…");
  const release = waitFor(MACHINE, REPO, "release.yml", since);
  console.log(`release.yml: ${release}`);
  const publicHalf = release === "success" ? waitFor(MACHINE, REPO, "public-release.yml", since) : "not started";
  console.log(`the public half: ${publicHalf}`);
  // The Pro editions, their image and the boxes' update, in the private repository the release starts (2026-11-06).
  const proHalf = release === "success" ? waitFor(MACHINE, PRO_REPO, "release.yml", since) : "not started";
  console.log(`the Pro half: ${proHalf}`);
  process.exit(release === "success" && publicHalf === "success" && proHalf === "success" ? 0 : 1);
}
