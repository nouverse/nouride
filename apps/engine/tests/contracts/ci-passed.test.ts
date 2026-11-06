/**
 * A commit already green is not tested again (0.8.17). `main` is fast-forwarded to a release branch's commit, whose run
 * there already passed: on `main` each of ci.yml's jobs is skipped where it passed on that commit, as release.yml's
 * verify jobs are on a tag. Both read a job's own conclusion, never a run's: `main`'s run, which skips its jobs, is a
 * successful run too.
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

  test("asks what passed only on main, allowed to read the runs, by each job's own conclusion", () => {
    const passed = all.passed ?? "";
    expect(passed).toContain("    if: ${{ github.ref == 'refs/heads/main' && github.repository_owner == 'nouverse' }}\n");
    expect(passed).toContain("      actions: read");
    expect(passed).toContain(BY_JOB);
    expect(passed).toContain("for job in verify verify-private helper; do");
  });

  test("skips every other job where it passed, and runs it everywhere else: a skipped `passed` does not skip it", () => {
    // `changes` and `docs` decide and run nothing a release depends on: what a push changed, and the light checks for docs.
    const others = Object.keys(all).filter((id) => !["passed", "changes", "docs"].includes(id));
    expect(others.toSorted()).toEqual(["helper", "verify", "verify-private"]);
    for (const id of others) {
      const block = all[id]!;
      const condition = /^ {4}if: (.*)$/m.exec(block)?.[1] ?? "";
      expect({ id, needs: /^ {4}needs: (.*)$/m.exec(block)?.[1] }).toEqual({ id, needs: "[passed, changes]" });
      // Without a status function GitHub skips a job whose need was skipped: every job off `main` would go.
      expect({ id, cancelled: condition.startsWith("${{ !cancelled() && ") }).toEqual({ id, cancelled: true });
      expect({ id, skipped: condition.includes(`needs.passed.outputs.${id.replaceAll("-", "_")} != 'yes'`) }).toEqual({ id, skipped: true });
    }
  });
});

describe("release.yml", () => {
  test("reads the same: each job's own conclusion in any successful run, not the newest run's", () => {
    const step = RELEASE.slice(RELEASE.indexOf("- name: Did CI already pass on this commit"), RELEASE.indexOf("- name: Is this a quiet release"));
    expect(step).toContain(BY_JOB);
    expect(step).not.toContain(".[0].databaseId");
    expect(step).toContain("grep -qx verify;");
    expect(step).toContain("grep -qx verify-private;");
  });
});
