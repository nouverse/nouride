/**
 * Where each workflow runs (2026-11-06: Nouride developed in public, as `nouverse/nouride`). Every job says
 * `github.repository_owner == 'nouverse'`: a fork carries these files, and without it a fork's own Actions would run
 * the release with nothing to sign it and no Pro code to build, or deploy a site it does not own.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../../../../.github/workflows");
const GUARD = "github.repository_owner == 'nouverse'";

/** Each job's `if:` at the job's own level, or "" when it has none. */
function jobConditions(yaml: string): { job: string; condition: string }[] {
  const jobs = yaml.split(/^jobs:\s*$/m)[1] ?? "";
  return jobs.split(/^(?=  [A-Za-z0-9_-]+:\s*$)/m).filter((block) => /^  [A-Za-z0-9_-]+:/.test(block)).map((block) => ({
    job: /^  ([A-Za-z0-9_-]+):/.exec(block)![1]!,
    condition: /^ {4}if: (.*)$/m.exec(block)?.[1] ?? "",
  }));
}

test("every job of every workflow runs only in nouverse's own repository, never in a fork", () => {
  const workflows = readdirSync(DIR).filter((name) => name.endsWith(".yml"));
  expect(workflows).toEqual(expect.arrayContaining(["ci.yml", "release.yml", "public-release.yml"]));
  for (const name of workflows) {
    const jobs = jobConditions(readFileSync(join(DIR, name), "utf8"));
    expect(jobs.length).toBeGreaterThan(0);
    for (const { job, condition } of jobs) expect({ name, job, guarded: condition.includes(GUARD) }).toEqual({ name, job, guarded: true });
  }
});

test("the Box's publisher is not among them: it is Pro's, in nouverse/nouride-pro", () => {
  expect(readdirSync(DIR)).not.toContain("publish-boxes.yml");
});
