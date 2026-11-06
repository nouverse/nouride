/**
 * `scripts/release/publish.ts` (0.8.18, REVIEW B1): what it refuses before a tag, every reason at once, and what it
 * runs once nothing does. A long-term patch leaves the mains alone and is tagged `[lts]`; a quiet one `[quiet]`.
 */

import { describe, expect, test } from "bun:test";
import { dirtyPaths, plan, refusals, settledRun, type PublishFacts } from "../../../../scripts/release/publish.ts";

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
  pins: [PIN("internals/pro", "b".repeat(40)), PIN("internals/nougate", "c".repeat(40)), PIN("content", "d".repeat(40))],
  mainFastForwards: true,
  ciGreen: true,
  stranded: [],
  tagExists: false,
};

describe("publishing a release", () => {
  test("a ready release is refused nothing, and its mains move before its tag", () => {
    expect(refusals(READY)).toEqual([]);
    expect(plan(READY)).toEqual([
      "git fetch . releases/v0.8.18:main",
      "git push origin main",
      `git -C internals/pro push origin ${"b".repeat(40)}:refs/heads/main`,
      `git -C internals/nougate push origin ${"c".repeat(40)}:refs/heads/main`,
      `git -C content push origin ${"d".repeat(40)}:refs/heads/main`,
      "git tag v0.8.18 releases/v0.8.18",
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
    expect(plan({ ...READY, mode: "quiet" }).slice(-2)).toEqual(['git tag -a v0.8.18 -m "[quiet]" releases/v0.8.18', "git push origin v0.8.18"]);
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
    expect(dirtyPaths(" M internals/pro\n M content", ".")).toEqual([]);
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
