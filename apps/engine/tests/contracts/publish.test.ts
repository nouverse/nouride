/**
 * `scripts/release/publish.ts`: what it refuses before a tag, every reason at once, and what it runs once nothing does,
 * with `gh` and `git` stood in for: the release's pull request opened (or the open one taken), its checks waited for,
 * merged with a merge commit, the branch deleted, the suite asked for on the merge and waited for, the tag on the merge.
 * A long-term patch has no pull request and is tagged `[lts]` on its branch; a quiet release is tagged `[quiet]`.
 */

import { describe, expect, test } from "bun:test";
import { dirtyPaths, plan, publish, refusals, run, settledChecks, settledRun, type PublishFacts, type PublishIo } from "../../../../scripts/release/publish.ts";

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
      "gh pr checks <n> --repo nouverse/nouride, until every check has ended, all green",
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
      "the mirror: v0.8.0 upgrades only from 0.7.28, …",
      "v0.8.18 already exists",
    ]);
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

const GREEN = "test\tpass\t9m\thttps://x\ncla\tpass\t2s\thttps://y";
const ON_ITS_WAY: [string, { ok?: boolean; out?: string } | { ok?: boolean; out?: string }[]][] = [
  ["gh pr list", { out: "" }],
  ["gh pr create", { out: "https://github.com/nouverse/nouride/pull/41\n" }],
  ["gh pr checks", [{ ok: false, out: "" }, { ok: false, out: "test\tpending\t0\thttps://x" }, { out: GREEN }]],
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
    // Asked three times: nothing listed yet, one running, all green. The suite's run is the one on the merge commit.
    expect(gh.calls.filter((line) => line.startsWith("gh pr checks 41"))).toHaveLength(3);
    expect(gh.calls.find((line) => line.startsWith("gh run list"))).toContain(`select(.headSha == "${MERGE}")`);
  });

  test("a pull request already open for the branch is taken, not opened again", () => {
    const gh = stood([["gh pr list", { out: "38\n" }], ...ON_ITS_WAY.slice(1)]);
    expect(publish(READY, gh.io)).toBe(MERGE);
    expect(gh.acts().filter((line) => line.startsWith("gh pr"))).toEqual(["gh pr merge 38 --repo nouverse/nouride --merge"]);
  });

  test("a red check stops it before the merge: nothing merged, deleted or tagged, and the person told how to go on", () => {
    const gh = stood([["gh pr checks", { ok: false, out: "test\tfail\t9m\thttps://x\ncla\tpass\t2s\thttps://y" }], ...ON_ITS_WAY.filter(([words]) => words !== "gh pr checks")]);
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
  test("green once all have ended with none failed; red on a failure or a cancel; waited for while one runs or none is listed", () => {
    expect(settledChecks(GREEN)).toBe("pass");
    expect(settledChecks("test\tpass\t9m\thttps://x\nlint\tskipping\t0\thttps://z")).toBe("pass");
    expect(settledChecks("test\tfail\t9m\thttps://x\ncla\tpending\t0\thttps://y")).toBe("fail");
    expect(settledChecks("test\tcancel\t9m\thttps://x")).toBe("fail");
    expect(settledChecks("test\tpending\t0\thttps://x\ncla\tpass\t2s\thttps://y")).toBeNull();
    expect(settledChecks("")).toBeNull();
  });
});
