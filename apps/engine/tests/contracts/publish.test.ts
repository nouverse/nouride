/**
 * `scripts/release/publish.ts`: what it refuses before a tag, every reason at once, and what it runs once nothing does,
 * with `gh` and `git` stood in for: the release's pull request opened (or the open one taken), its checks waited for,
 * merged with a merge commit, the branch deleted, the suite asked for on the merge and waited for, the tag on the merge.
 * A long-term patch has no pull request and is tagged `[lts]` on its branch; a quiet release is tagged `[quiet]`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciRunsOf, dirtyPaths, notices, plan, publish, PR_WORKFLOWS, readMerged, refusals, run, settledChecks, settledRun, unlistedChecks, type PublishFacts, type PublishIo, ciOnHead } from "../../../../scripts/release/publish.ts";

const PIN = (path: string, pin: string) => ({ path, pin, onRemote: true, mainFastForwards: true });
const READY: PublishFacts = {
  tag: "v0.8.18",
  mode: "ordinary",
  branch: "releases/v0.8.18",
  version: "0.8.18",
  notes: true,
  dirty: [],
  head: "a".repeat(40),
  pushedHead: "a".repeat(40),
  pins: [PIN("internals/pro", "b".repeat(40)), PIN("internals/nougate", "c".repeat(40))],
  mainFastForwards: true,
  ciGreen: true,
  stranded: [],
  tagExists: false,
};

describe("publishing a release", () => {
  test("a ready release is refused nothing, and its dry run names the pull request's steps before the tag", () => {
    expect(refusals(READY)).toEqual([]);
    expect(plan(READY)).toEqual([
      "gh pr create --repo nouverse/nouride --base main --head releases/v0.8.18 --title v0.8.18 --body-file docs/releases/v0.8.18.md (or the one open)",
      "gh pr checks <n> --repo nouverse/nouride, until the pull request's own checks (pr, cla) are listed and every check has ended, all green",
      "gh pr merge <n> --repo nouverse/nouride --merge",
      "git push origin --delete releases/v0.8.18",
      "gh workflow run ci.yml --repo nouverse/nouride --ref main, until its run on <merge> has ended green",
      `git -C internals/pro push origin ${"b".repeat(40)}:refs/heads/main`,
      `git -C internals/nougate push origin ${"c".repeat(40)}:refs/heads/main`,
      "git tag v0.8.18 <merge>",
      "git push origin v0.8.18",
    ]);
  });

  test("every reason is said at once", () => {
    const said = refusals({
      ...READY,
      branch: "releases/v0.8.19",
      version: "0.8.17",
      notes: false,
      dirty: ["internals/pro: docs/rfc/README.md"],
      pushedHead: "e".repeat(40),
      pins: [{ path: "internals/pro", pin: "b".repeat(40), onRemote: false, mainFastForwards: false }],
      mainFastForwards: false,
      ciGreen: false,
      stranded: ["v0.8.0 upgrades only from 0.7.28, …"],
      tagExists: true,
    });
    expect(said).toEqual([
      "the checkout is on releases/v0.8.19, not releases/v0.8.18",
      "package.json says 0.8.17, not 0.8.18: run ./bump-version 0.8.18",
      "docs/releases/v0.8.18.md is missing: the release pages are written from it",
      "uncommitted: internals/pro: docs/rfc/README.md",
      "releases/v0.8.19 is not pushed as it stands (here aaaaaaaa, the remote eeeeeeee)",
      "internals/pro's pin bbbbbbbb is on no branch of its remote: CI cannot clone it",
      "internals/pro's main cannot fast-forward to its pin bbbbbbbb",
      "main cannot fast-forward to releases/v0.8.19: take what main has first (merge, never cherry-pick)",
      "ci.yml has not passed on aaaaaaaa: wait for it, or push and wait",
      "v0.8.18 already exists",
    ]);
  });

  // A release was held for a stone still on the mirror's page, with everything else green.
  test("a stepping stone leaving the mirror's page is said beside the plan and refuses nothing", () => {
    const leaving = { ...READY, stranded: ["v0.8.0 upgrades only from 0.7.28, …"] };
    expect(refusals(leaving)).toEqual([]);
    expect(notices(leaving)).toEqual(["the mirror: v0.8.0 upgrades only from 0.7.28, …"]);
    expect(notices(READY)).toEqual([]);
  });

  test("a branch never pushed is said so", () => {
    expect(refusals({ ...READY, pushedHead: null })).toEqual(["releases/v0.8.18 was never pushed"]);
  });

  test("a long-term patch: from its lts/ branch, the mains left alone, tagged [lts]", () => {
    const lts: PublishFacts = { ...READY, tag: "v1.0.8", mode: "lts", branch: "lts/1.0", version: "1.0.8", mainFastForwards: false, pins: READY.pins.map((pin) => ({ ...pin, mainFastForwards: false })) };
    expect(refusals(lts)).toEqual([]);
    expect(plan(lts)).toEqual(['git tag -a v1.0.8 -m "[lts]" lts/1.0', "git push origin v1.0.8"]);
    expect(refusals({ ...lts, tag: "v1.1.1", version: "1.1.1" })).toEqual(["v1.1.1 is not on the 1.0 line its branch is for"]);
    expect(refusals({ ...lts, branch: "releases/v1.0.8" })).toEqual(["the checkout is on releases/v1.0.8, not a lts/<line> branch"]);
  });

  test("a quiet release moves the mains and is tagged [quiet]", () => {
    expect(plan({ ...READY, mode: "quiet" }).slice(-2)).toEqual(['git tag -a v0.8.18 -m "[quiet]" <merge>', "git push origin v0.8.18"]);
  });
});

describe("what is uncommitted", () => {
  test("a path is read whole, the first line's leading space a column, not something to trim", () => {
    expect(dirtyPaths(" M .github/workflows/release.yml\nA  scripts/release/publish.ts\n?? notes.md", ".")).toEqual([
      ".: .github/workflows/release.yml",
      ".: scripts/release/publish.ts",
      ".: notes.md",
    ]);
  });

  test("a submodule's own entry is left to its tree, which is read on its own", () => {
    expect(dirtyPaths(" M internals/pro\n M internals/nougate", ".")).toEqual([]);
  });
});

describe("waiting for a run", () => {
  // Asked while a push's run was ending, the release was refused for a run green seconds later.
  test("ci on the release's commit: green once one run passed, running while none has and one is not over, none otherwise", () => {
    expect(ciOnHead("completed:success")).toBe("green");
    // The push's checks green, the asked-for suite still going: green is green.
    expect(ciOnHead("in_progress: completed:success")).toBe("green");
    expect(ciOnHead("in_progress:")).toBe("running");
    expect(ciOnHead("queued: completed:failure")).toBe("running");
    expect(ciOnHead("completed:failure completed:cancelled")).toBe("none");
    expect(ciOnHead("")).toBe("none");
    // A run that says it completed and names no outcome yet is not over: waited for, not refused.
    expect(ciOnHead("completed:")).toBe("running");
  });

  test("its outcome is the run's own, read once it completed: a watch cut off by the network is no failure (0.8.18)", () => {
    expect(settledRun("completed success")).toBe("success");
    expect(settledRun("completed failure")).toBe("failure");
    expect(settledRun("completed cancelled")).toBe("failure");
    // Still running, or nothing read (the TLS handshake that timed out): watched again, never called failed.
    expect(settledRun("in_progress ")).toBeNull();
    expect(settledRun("queued ")).toBeNull();
    expect(settledRun("")).toBeNull();
  });
});

const MERGE = "d".repeat(40);

/**
 * `gh` and `git` as a script: each call is answered by the first rule whose words it starts with (a rule's answer may
 * be a list, one a call, the last kept), and every call is recorded. A call no rule names succeeds and prints nothing.
 */
function stood(rules: [string, { ok?: boolean; out?: string } | { ok?: boolean; out?: string }[]][]) {
  const calls: string[] = [];
  const said: string[] = [];
  const left = new Map(rules.map(([words, answer]) => [words, Array.isArray(answer) ? [...answer] : [answer]]));
  const io: PublishIo = {
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const words = rules.find(([start]) => line.startsWith(start))?.[0];
      const answers = words ? left.get(words)! : [];
      const answer = (answers.length > 1 ? answers.shift() : answers[0]) ?? {};
      return { ok: answer.ok ?? true, out: answer.out ?? "" };
    },
    sleep: () => {},
    say: (line) => void said.push(line),
  };
  /** The calls that change something, in order: what was asked of GitHub and pushed. Reads are left out. */
  const acts = () => calls.filter((line) => !/^gh (pr (list|checks|view)|run (list|view))\b/.test(line));
  return { io, calls, said, acts };
}

/** The branch's own `ci` runs, green from its push: what a pull request lists the moment it is opened. */
const BRANCH_CI = "ci\tchanges\tpass\nci\tchecks\tpass\nci\tverify\tskipping";
const GREEN = `${BRANCH_CI}\npr\tchecks\tpass\ncla\tcla\tpass`;
const ON_ITS_WAY: [string, { ok?: boolean; out?: string } | { ok?: boolean; out?: string }[]][] = [
  ["gh pr list", { out: "" }],
  ["gh pr create", { out: "https://github.com/nouverse/nouride/pull/41\n" }],
  ["gh pr checks", [{ ok: false, out: "" }, { out: BRANCH_CI }, { ok: false, out: `${BRANCH_CI}\npr\tchecks\tpending\ncla\tcla\tpass` }, { out: GREEN }]],
  ["gh pr view", { out: `${MERGE}\n` }],
  ["gh run list", { out: "777" }],
  ["gh run view", [{ out: "in_progress " }, { out: "completed success" }]],
];

describe("publishing through the release's pull request, gh stood in for", () => {
  test("opened, its checks waited for, merged with a merge commit, the branch deleted, the suite on the merge, then the tag on it", () => {
    const gh = stood(ON_ITS_WAY);
    expect(publish(READY, gh.io)).toBe(MERGE);
    expect(gh.acts()).toEqual([
      "gh pr create --repo nouverse/nouride --base main --head releases/v0.8.18 --title v0.8.18 --body-file docs/releases/v0.8.18.md",
      "gh pr merge 41 --repo nouverse/nouride --merge",
      "git push origin --delete releases/v0.8.18",
      "gh workflow run ci.yml --repo nouverse/nouride --ref main",
      "git fetch -q origin",
      `git -C internals/pro push origin ${"b".repeat(40)}:refs/heads/main`,
      `git -C internals/nougate push origin ${"c".repeat(40)}:refs/heads/main`,
      `git tag v0.8.18 ${MERGE}`,
      "git push origin v0.8.18",
    ]);
    // Asked four times: nothing listed yet, the branch's green runs alone (a release was merged here), its own check running,
    // all green. The suite's run is the one on the merge commit.
    expect(gh.calls.filter((line) => line.startsWith("gh pr checks 41"))).toHaveLength(4);
    expect(gh.calls.find((line) => line.startsWith("gh pr checks 41"))).toContain("--json workflow,name,bucket");
    expect(gh.calls.find((line) => line.startsWith("gh run list"))).toContain(`select(.headSha == "${MERGE}")`);
  });

  test("a pull request already open for the branch is taken, not opened again", () => {
    const gh = stood([["gh pr list", { out: "38\n" }], ...ON_ITS_WAY.slice(1)]);
    expect(publish(READY, gh.io)).toBe(MERGE);
    expect(gh.acts().filter((line) => line.startsWith("gh pr"))).toEqual(["gh pr merge 38 --repo nouverse/nouride --merge"]);
  });

  test("a red check stops it before the merge: nothing merged, deleted or tagged, and the person told how to go on", () => {
    const gh = stood([["gh pr checks", { ok: false, out: `${BRANCH_CI}\npr\tchecks\tfail\ncla\tcla\tpass` }], ...ON_ITS_WAY.filter(([words]) => words !== "gh pr checks")]);
    expect(publish(READY, gh.io)).toBeNull();
    expect(gh.acts()).toEqual(["gh pr create --repo nouverse/nouride --base main --head releases/v0.8.18 --title v0.8.18 --body-file docs/releases/v0.8.18.md"]);
    expect(gh.said.at(-1)).toContain("nothing is merged");
  });

  test("the suite red on the merge commit: merged, and never tagged", () => {
    const gh = stood([["gh run view", { out: "completed failure" }], ...ON_ITS_WAY.filter(([words]) => words !== "gh run view")]);
    expect(publish(READY, gh.io)).toBeNull();
    expect(gh.acts().some((line) => line.startsWith("git tag") || line.startsWith("git push origin v0.8.18"))).toBe(false);
    expect(gh.acts()).toContain("gh pr merge 41 --repo nouverse/nouride --merge");
    expect(gh.said.at(-1)).toContain("Nothing is tagged");
  });

  test("a quiet release is tagged [quiet] on the merge; a long-term patch has no pull request at all", () => {
    const quiet = stood(ON_ITS_WAY);
    publish({ ...READY, mode: "quiet" }, quiet.io);
    expect(quiet.acts().at(-2)).toBe(`git tag -a v0.8.18 -m [quiet] ${MERGE}`);
    const lts = stood([]);
    expect(publish({ ...READY, tag: "v1.0.8", mode: "lts", branch: "lts/1.0" }, lts.io)).toBe(READY.head);
    expect(lts.calls).toEqual(["git tag -a v1.0.8 -m [lts] lts/1.0", "git push origin v1.0.8"]);
  });
});

describe("what a command answers", () => {
  // The public list of releases grew past 1 MiB with thirty releases' notes in it, and the read was taken as a failure.
  test("is read whole past a megabyte, and still says a command that failed", () => {
    const long = run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2_000_000))"]);
    expect([long.ok, long.out.length]).toEqual([true, 2_000_000]);
    expect(run(process.execPath, ["-e", "process.exit(3)"]).ok).toBe(false);
  });
});

describe("a pull request's checks", () => {
  test("green once its own checks are listed and all have ended; red on a failure or a cancel; waited for while one runs", () => {
    expect(settledChecks(GREEN)).toBe("pass");
    expect(settledChecks(`${BRANCH_CI}\npr\tchecks\tfail\ncla\tcla\tpending`)).toBe("fail");
    expect(settledChecks(`${BRANCH_CI}\npr\tchecks\tcancel\ncla\tcla\tpass`)).toBe("fail");
    expect(settledChecks(`${BRANCH_CI}\npr\tchecks\tpending\ncla\tcla\tpass`)).toBeNull();
    expect(settledChecks("")).toBeNull();
  });

  test("the branch's green runs alone are not the pull request's checks: 0.8.45's was merged on them, six seconds old", () => {
    expect(settledChecks(BRANCH_CI)).toBeNull();
    expect(unlistedChecks(BRANCH_CI)).toEqual(["pr", "cla"]);
    // One of its own listed and the other not yet: still waited for, and the one missing is named.
    expect(settledChecks(`${BRANCH_CI}\ncla\tcla\tpass`)).toBeNull();
    expect(unlistedChecks(`${BRANCH_CI}\ncla\tcla\tpass`)).toEqual(["pr"]);
    expect(settledChecks(`${BRANCH_CI}\npr\tchecks\tpass`)).toBeNull();
    // A job of `ci` named as the pull request's workflow is, is not it: the workflow is read, never the job's name.
    expect(settledChecks("ci\tpr\tpass\nci\tcla\tpass")).toBeNull();
    // A red run of the branch is a red check whether or not the pull request's own are listed yet.
    expect(settledChecks("ci\tchecks\tfail")).toBe("fail");
  });

  test("a pull request that never lists a check of its own is not merged, and the person is told which", () => {
    const gh = stood([["gh pr checks", { out: `${BRANCH_CI}\ncla\tcla\tpass` }], ...ON_ITS_WAY.filter(([words]) => words !== "gh pr checks")]);
    expect(publish(READY, gh.io)).toBeNull();
    expect(gh.acts()).toEqual(["gh pr create --repo nouverse/nouride --base main --head releases/v0.8.18 --title v0.8.18 --body-file docs/releases/v0.8.18.md"]);
    expect(gh.said.at(-1)).toBe("✗ #41 never listed a check of its own (pr): nothing is merged");
  });

  test("the workflows waited for are the ones the repository has, by the names their files give them", () => {
    const root = join(import.meta.dir, "../../../..");
    for (const workflow of PR_WORKFLOWS) {
      const text = readFileSync(join(root, ".github/workflows", `${workflow}.yml`), "utf8");
      expect(text).toMatch(new RegExp(`^name: ${workflow}$`, "m"));
      // Both run for a pull request into `main`: renamed, or moved off pull requests, the release would wait three hours.
      expect(text).toMatch(/^ {2}pull_request(_target)?:/m);
    }
  });
});

const ON_MAIN: PublishFacts = { ...READY, branch: "main", ciGreen: false, head: MERGE, pushedHead: MERGE, merged: { pr: "41", commit: MERGE, held: true }, suiteGreen: false };

describe("a release whose pull request is merged already, published from main", () => {
  test("is refused nothing, and its plan is the suite on main's commit, the submodules' main, the tag", () => {
    expect(refusals(ON_MAIN)).toEqual([]);
    expect(plan(ON_MAIN)).toEqual([
      "gh workflow run ci.yml --repo nouverse/nouride --ref main, until its run on dddddddd has ended green",
      `git -C internals/pro push origin ${"b".repeat(40)}:refs/heads/main`,
      `git -C internals/nougate push origin ${"c".repeat(40)}:refs/heads/main`,
      `git tag v0.8.18 ${MERGE}`,
      "git push origin v0.8.18",
    ]);
    expect(plan({ ...ON_MAIN, suiteGreen: true })[0]).toBe("(the suite asked for has passed on dddddddd: not asked again)");
    expect(notices(ON_MAIN)).toEqual([]);
  });

  test("on main with no pull request of the release merged, or without its merge commit, it is refused and says what to do", () => {
    expect(refusals({ ...ON_MAIN, merged: null })).toEqual(["the checkout is on main, and no pull request from releases/v0.8.18 was merged: check out releases/v0.8.18"]);
    expect(refusals({ ...ON_MAIN, merged: { pr: "41", commit: MERGE, held: false } })).toEqual(["main here does not hold #41's merge commit dddddddd: git pull"]);
    // What a release needs on its branch it needs here too: the version, the notes, a pushed and clean tree, no tag.
    expect(refusals({ ...ON_MAIN, version: "0.8.17", notes: false, pushedHead: "e".repeat(40), tagExists: true })).toHaveLength(4);
    // And a long-term patch is never read as this: `main` is not its branch.
    expect(refusals({ ...ON_MAIN, mode: "lts", tag: "v1.0.8", version: "1.0.8" })[0]).toBe("the checkout is on main, not a lts/<line> branch");
  });

  test("the suite is asked for on main, waited for on that commit, then the tag: no pull request is opened, merged or deleted", () => {
    const gh = stood(ON_ITS_WAY);
    expect(publish(ON_MAIN, gh.io)).toBe(MERGE);
    expect(gh.acts()).toEqual([
      "gh workflow run ci.yml --repo nouverse/nouride --ref main",
      "git fetch -q origin",
      `git -C internals/pro push origin ${"b".repeat(40)}:refs/heads/main`,
      `git -C internals/nougate push origin ${"c".repeat(40)}:refs/heads/main`,
      `git tag v0.8.18 ${MERGE}`,
      "git push origin v0.8.18",
    ]);
    expect(gh.calls.some((line) => line.startsWith("gh pr"))).toBe(false);
    expect(gh.calls.find((line) => line.startsWith("gh run list"))).toContain(`select(.headSha == "${MERGE}")`);
  });

  test("a suite asked for that has passed on the commit is not asked again", () => {
    const gh = stood(ON_ITS_WAY);
    expect(publish({ ...ON_MAIN, suiteGreen: true }, gh.io)).toBe(MERGE);
    expect(gh.acts()[0]).toBe("git fetch -q origin");
    expect(gh.calls.some((line) => line.startsWith("gh workflow run") || line.startsWith("gh run"))).toBe(false);
  });

  test("the suite red on main's commit: nothing is tagged and no main is moved", () => {
    const gh = stood([["gh run view", { out: "completed failure" }], ...ON_ITS_WAY.filter(([words]) => words !== "gh run view")]);
    expect(publish(ON_MAIN, gh.io)).toBeNull();
    expect(gh.acts()).toEqual(["gh workflow run ci.yml --repo nouverse/nouride --ref main"]);
    expect(gh.said.at(-1)).toContain("Nothing is tagged");
  });

  test("main past the merge commit: the tag goes on main's commit, and that is said", () => {
    const past = { ...ON_MAIN, head: "e".repeat(40), pushedHead: "e".repeat(40) };
    expect(refusals(past)).toEqual([]);
    expect(notices(past)).toEqual(["main is past #41's merge commit dddddddd: the tag goes on main's commit eeeeeeee"]);
    expect(plan(past).at(-2)).toBe(`git tag v0.8.18 ${"e".repeat(40)}`);
    const gh = stood(ON_ITS_WAY);
    expect(publish(past, gh.io)).toBe("e".repeat(40));
    expect(gh.calls.find((line) => line.startsWith("gh run list"))).toContain(`select(.headSha == "${"e".repeat(40)}")`);
  });

  test("on main only a suite that was asked for counts: a push's run there is the lint and the contract tests", () => {
    expect(ciRunsOf(MERGE, true)).toBe(`repos/nouverse/nouride/actions/workflows/ci.yml/runs?head_sha=${MERGE}&event=workflow_dispatch&per_page=20`);
    expect(ciRunsOf(MERGE, false)).toBe(`repos/nouverse/nouride/actions/workflows/ci.yml/runs?head_sha=${MERGE}&per_page=20`);
    // And the workflow still runs the suite only when asked: were `verify` moved to pushes, this filter would hide it.
    const ci = readFileSync(join(import.meta.dir, "../../../..", ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/^ {2}verify:\n(?: {4}.*\n)*? {4}if: \$\{\{ github\.event_name == 'workflow_dispatch'/m);
  });

  test("the merged pull request is read from what gh prints, and anything else is none", () => {
    // gh's own answer to `pr list --state merged --json number,mergeCommit`, copied from a real one.
    const printed = `[{"mergeCommit":{"oid":"${MERGE}"},"number":41}]\n`;
    expect(readMerged(printed, () => true)).toEqual({ pr: "41", commit: MERGE, held: true });
    expect(readMerged(printed, () => false)).toEqual({ pr: "41", commit: MERGE, held: false });
    // The newest comes first: a release merged twice (a fix after its first merge) is tagged from the later one.
    expect(readMerged(`[{"mergeCommit":{"oid":"${"f".repeat(40)}"},"number":42},{"mergeCommit":{"oid":"${MERGE}"},"number":41}]`, () => true)?.pr).toBe("42");
    for (const none of ["[]", "", "not json", `[{"number":41,"mergeCommit":null}]`, `[{"number":41,"mergeCommit":{"oid":"abc"}}]`, `{"number":41}`, `41 ${MERGE}`, `[{"mergeCommit":{"oid":"${MERGE}"}}]`, `[{"number":"41","mergeCommit":{"oid":"${MERGE}"}}]`]) expect(readMerged(none, () => true)).toBeNull();
  });

  test("gh is asked for the merged pull request in a form no shell or string escape can change", () => {
    // A dry run on main, the release's pull request merged, said none was: the question was a jq program written
    // "\(.number)" in a JavaScript string, which drops the backslash, and gh printed the program's text. The reader's
    // test fed it the right text by hand. gh is asked for JSON alone now, and the reader reads that.
    const source = readFileSync(join(import.meta.dir, "../../../..", "scripts/release/publish.ts"), "utf8");
    const asked = source.split("\n").find((line) => line.includes('"--state", "merged"')) ?? "";
    expect(asked).toContain('"--json", "number,mergeCommit"]');
    expect(asked).not.toContain("--jq");
  });
});
