/**
 * Every action a workflow runs is pinned to a commit, and the release workflow writes only where a job needs to.
 *
 * A tag moves: one compromised upstream tag ran inside the job that holds the release signing key every box trusts.
 * A commit does not. The version beside each pin is what dependabot reads to propose the next one.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../../../../.github/workflows");
const workflows = readdirSync(DIR).filter((name) => name.endsWith(".yml")).map((name) => [name, readFileSync(join(DIR, name), "utf8")] as const);

describe("the workflows", () => {
  test("pin every action to a commit, with the version it is beside it", () => {
    const loose = workflows.flatMap(([name, text]) =>
      [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)]
        .filter(([, ref, rest]) => !/@[0-9a-f]{40}$/.test(ref!) || !/#\s*v\d+\.\d+\.\d+/.test(rest!))
        .map(([, ref]) => `${name}: ${ref}`),
    );
    expect(workflows.length).toBeGreaterThan(0);
    expect(loose).toEqual([]);
  });

  test("the release workflow reads by default, and a job asks for what it writes", () => {
    const release = workflows.find(([name]) => name === "release.yml")![1];
    const top = release.slice(0, release.indexOf("\njobs:"));
    // The workflow-wide block: the lines under `permissions:` until the next top-level key.
    const block = /\npermissions:\n((?: {2}.*\n)*)/.exec(top)?.[1] ?? "";
    expect(block).toBe("  contents: read\n");
  });

  test("a pull request starts two workflows and no other: what each may do is `pull-request-workflows.test.ts`'s", () => {
    // Nouride's own work is pushed to a release branch. A trigger added to any other workflow would run a fork's code
    // with what that workflow holds: a token that writes, a secret, or the machine that builds and signs releases.
    const started = workflows.filter(([, text]) => /\n {2}pull_request(_target)?:/.test(text)).map(([name]) => name);
    expect(started.sort()).toEqual(["cla.yml", "pr.yml"]);
  });
});
