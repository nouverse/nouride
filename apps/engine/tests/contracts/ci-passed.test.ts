/**
 * What already passed on a commit is not run again. `main` is fast-forwarded to a release branch's commit, whose run
 * there already passed: on `main` each of a push's jobs in ci.yml is skipped where it passed on that commit. And a tag
 * does not run the whole suite again where ci.yml's `verify` passed on its commit, which it does only when the suite
 * was asked for there: a push runs the lint and the contract tests, never the suite. Both read a job's own conclusion,
 * never a run's: `main`'s run, which skips its jobs, is a successful run too.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "../../../../.github/workflows");
const CI = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
const RELEASE = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
/** How both find what passed: the jobs that succeeded, by name, in ci.yml's successful runs of the commit. */
const BY_JOB = `--jq '.jobs[] | select(.conclusion == "success") | .name'`;

/** A workflow's jobs, each its block of lines, by id. */
function jobs(workflow: string): Record<string, string> {
  const lines = workflow.slice(workflow.indexOf("\njobs:\n") + 7).split("\n");
  const out: Record<string, string> = {};
  let current = "";
  for (const line of lines) {
    const header = /^ {2}([a-z][\w-]*):$/.exec(line);
    if (header) current = header[1]!;
    else if (current) out[current] = `${out[current] ?? ""}${line}\n`;
  }
  return out;
}

describe("ci.yml", () => {
  const all = jobs(CI);
  const condition = (id: string): string => /^ {4}if: (.*)$/m.exec(all[id] ?? "")?.[1] ?? "";
  /** What a push runs. `passed` and `changes` decide and run nothing a release depends on. */
  const ON_A_PUSH = ["checks", "helper"];
  /** What runs once a release, when asked: the whole suite, and the same over the private submodules. */
  const WHEN_ASKED = ["verify", "verify-private"];

  test("has a push's jobs, the suite's two, and the two that decide: no other", () => {
    expect(Object.keys(all).toSorted()).toEqual(["changes", "passed", ...ON_A_PUSH, ...WHEN_ASKED].toSorted());
  });

  test("asks what passed only on main, allowed to read the runs, by each job's own conclusion", () => {
    const passed = all.passed ?? "";
    expect(passed).toContain("    if: ${{ github.ref == 'refs/heads/main' && github.repository_owner == 'nouverse' }}\n");
    expect(passed).toContain("      actions: read");
    expect(passed).toContain(BY_JOB);
    expect(passed).toContain(`for job in ${ON_A_PUSH.join(" ")}; do`);
  });

  test("skips each of a push's jobs where it passed, and runs it everywhere else: a skipped `passed` does not skip it", () => {
    for (const id of ON_A_PUSH) {
      expect({ id, needs: /^ {4}needs: \[passed[,\]]/m.test(all[id]!) }).toEqual({ id, needs: true });
      // Without a status function GitHub skips a job whose need was skipped: every job off `main` would go.
      expect({ id, cancelled: condition(id).startsWith("${{ !cancelled() && ") }).toEqual({ id, cancelled: true });
      expect({ id, skipped: condition(id).includes(`needs.passed.outputs.${id.replaceAll("-", "_")} != 'yes'`) }).toEqual({ id, skipped: true });
    }
  });

  test("a push runs the lint and the contract tests, never the whole suite", () => {
    const checks = all.checks ?? "";
    expect(condition("checks")).toContain("github.event_name == 'push'");
    for (const step of ["bun run lint:check", "bun run lint:site", "bun run test:contracts"]) expect(checks).toContain(`      - run: ${step}\n`);
    expect(checks).not.toContain("      - run: bun run test\n");
  });

  test("the whole suite runs when asked and only then, with nothing to skip it: a tag reads these two jobs by name", () => {
    expect(CI).toMatch(/^on:\n {2}push:\n(?: .*\n)*? {2}workflow_dispatch:\n/m);
    for (const id of WHEN_ASKED) {
      expect({ id, condition: condition(id) }).toEqual({ id, condition: "${{ github.event_name == 'workflow_dispatch' && github.repository_owner == 'nouverse' }}" });
      expect({ id, needs: /^ {4}needs:/m.test(all[id]!) }).toEqual({ id, needs: false });
    }
    expect(all.verify).toContain("      - run: bun run lint:check\n");
    expect(all.verify).toContain("      - run: bun run test\n");
    // A push's checks and an asked-for suite on one branch are two answers: neither run cancels the other.
    expect(CI).toContain("  group: ci-${{ github.event_name }}-${{ github.ref }}\n");
  });
});

describe("release.yml", () => {
  test("reads the same: each job's own conclusion in any successful run, not the newest run's", () => {
    const step = RELEASE.slice(RELEASE.indexOf("- name: Did CI already pass on this commit"), RELEASE.indexOf("- name: Is this a quiet release"));
    expect(step).toContain(BY_JOB);
    expect(step).not.toContain(".[0].databaseId");
    expect(step).toContain("grep -qx verify;");
    expect(step).toContain("grep -qx verify-private;");
    // A push's `checks` passing says nothing of the suite: only the two jobs that ran it let a tag skip it.
    expect(step).not.toContain("checks");
  });
});
