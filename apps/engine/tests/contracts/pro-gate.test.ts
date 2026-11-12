/**
 * The Pro code is gated: tested, typechecked and linted on a push to this repository, and before a tag builds a Pro
 * edition from it.
 *
 * The Box editions are built from `internals/pro` — pairing, licensing, onboarding, the update source, multi-user,
 * sign-in, flash — and until 0.7.9 no CI or release step tested, typechecked or linted any of it: `verify` checks out
 * no submodule, so about 215 Pro tests and the engine's drift tests against the plugins skipped, the lints globbed only
 * `{apps,packages}`, and `binaries` checked the code out only to build it.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintedFiles, proProjects } from "../../../../scripts/lint-sources.ts";

const ROOT = join(import.meta.dir, "../../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const CHECKED_OUT = existsSync(join(ROOT, "internals/pro/package.json"));

/** Each job's text, by name: the lines under `jobs:` from one two-space key to the next. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = body.split(/^(?= {2}[a-z][a-z-]*:\s*$)/m);
  return new Map(parts.map((part): [string, string] => [/^ {2}([a-z][a-z-]*):/.exec(part)?.[1] ?? "", part]).filter(([name]) => name));
}

/** The shell of one step's `run: |` block, as the runner gets it. */
function runOf(job: string, step: string): string {
  const lines = job.slice(job.indexOf(`- name: ${step}`)).split("\n");
  const start = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  const indent = /^(\s*)/.exec(lines[start + 1]!)![1]!.length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && /^(\s*)/.exec(line)![1]!.length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

describe("ci.yml", () => {
  const job = jobs(read(".github/workflows/ci.yml")).get("verify-private") ?? "";
  // The Pro checks themselves, in nouverse/nouride-pro since the main repository went public (2026-11-06).
  const proVerify = existsSync(join(ROOT, "internals/pro/.github/workflows/verify.yml")) ? read("internals/pro/.github/workflows/verify.yml") : null;

  test("verifies the Pro code on a push, in nouverse/nouride-pro, whose logs are private", () => {
    // Pushes only, and only in nouverse's own repository: a fork holds no token (workflow-repository.test.ts).
    expect(job).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && github\.event_name == 'push' && .* && github\.repository_owner == 'nouverse' \}\}$/m);
    expect(job).toContain('gh workflow run verify.yml --repo nouverse/nouride-pro -f ref="${GITHUB_SHA}"');
    // Its conclusion decides this job: anything but success fails it.
    expect(job).toContain('[ "${conclusion}" = "success" ] ||');
    // Nothing of Pro's is checked out or run here.
    expect(job).not.toContain("internals/pro");
  });

  test.skipIf(proVerify === null)("and that run checks everything over it: the lints, the whole suite, and a Pro build", () => {
    for (const step of ["bun run lint:check", "bun run test", "bun run build:pro --pro --bundle-only"]) expect(proVerify).toContain(`- run: ${step}`);
    // The submodules at the commits the main repository pins, not their branches' tips.
    expect(proVerify).toContain("ref: ${{ steps.pins.outputs.pro }}");
    expect(proVerify).toContain("ref: ${{ steps.pins.outputs.nougate }}");
  });

  test("a missing token fails the job rather than skipping it", () => {
    const run = spawnSync("sh", ["-c", runOf(job, "The Pro checks in nouverse/nouride-pro, for this commit")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GH_TOKEN: "" } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::RELEASES_REPO_TOKEN is not set");
  });
});

describe("ci.yml waits for the Pro checks to end", () => {
  const job = jobs(read(".github/workflows/ci.yml")).get("verify-private") ?? "";
  const step = runOf(job, "The Pro checks in nouverse/nouride-pro, for this commit");

  /**
   * The step, with a `gh` that answers as GitHub does over a run's life and a `sleep` that does not wait: started,
   * found, then asked how it is. `asks` is what each of those asks is answered: a line of `status conclusion`, or
   * `fail` for a request that fails. The last one is repeated.
   */
  function waited(asks: string[]): { status: number | null; out: string; asked: number } {
    const dir = mkdtempSync(join(tmpdir(), "pro-gate-"));
    try {
      asks.forEach((line, at) => writeFileSync(join(dir, `answer-${at + 1}`), line));
      writeFileSync(
        join(dir, "gh"),
        [
          "#!/bin/sh",
          'case "$1 $2" in',
          '  "workflow run") exit 0 ;;',
          '  "run list") echo 77 ;;',
          // What the step replaced: it gives up, as it did on the day this was written.
          '  "run watch") exit 1 ;;',
          '  "run view")',
          `    n=$(($(cat "${dir}/asked" 2>/dev/null || echo 0) + 1)); echo "$n" > "${dir}/asked"`,
          `    [ -f "${dir}/answer-$n" ] || n=${asks.length}`,
          `    line=$(cat "${dir}/answer-$n")`,
          '    [ "$line" = fail ] && exit 1',
          '    echo "$line" ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // `-e`, as the runner's shell has it: a command that fails ends the step unless the step says otherwise.
      const run = spawnSync("sh", ["-e", "-c", step], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, GH_TOKEN: "t", GITHUB_SHA: "abc" } });
      return { status: run.status, out: run.stdout + run.stderr, asked: Number(readFileSync(join(dir, "asked"), "utf8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("through a request that fails and a run still at work, to the run's own conclusion", () => {
    const passed = waited(["fail", "queued ", "in_progress ", "fail", "in_progress ", "completed success"]);
    expect(passed.out).toContain("the Pro checks: success");
    expect(passed.status).toBe(0);
    expect(passed.asked).toBe(6);
  });

  test("a run that ends any other way fails the job, by what it ended as", () => {
    for (const ended of ["failure", "cancelled", "timed_out"]) {
      const failed = waited(["in_progress ", `completed ${ended}`]);
      expect(failed.out, ended).toContain(`::error::the Pro checks ended '${ended}'`);
      expect(failed.status, ended).toBe(1);
    }
  });

  test("a run that never ends fails the job after its 55 minutes, and is not read as ended with nothing", () => {
    const never = waited(["in_progress "]);
    expect(never.out).toContain("::error::the Pro checks had not ended after 55 minutes (their run is 77 in nouverse/nouride-pro).");
    expect(never.out).not.toContain("ended ''");
    expect(never.status).toBe(1);
    // A hundred and ten asks, thirty seconds apart: inside the job's sixty minutes.
    expect(never.asked).toBe(110);
    expect(job).toContain("timeout-minutes: 60");
  });
});

describe("release.yml", () => {
  const all = jobs(read(".github/workflows/release.yml"));

  test("runs the same gate on a tag that builds a Pro edition, unless ci.yml's already passed on that commit", () => {
    const verify = all.get("verify-private") ?? "";
    expect(verify).toContain("needs.guard-visibility.outputs.private_variants != ''");
    expect(verify).toContain("needs.guard-visibility.outputs.ci_private_green != 'yes'");
    for (const step of ["bun run lint:check", "bun run test", "bun run build:pro --pro --bundle-only"]) expect(verify).toContain(`- run: ${step}`);
    // Green only when that job passed, not when the run it was in was green with the job skipped.
    expect(all.get("guard-visibility")).toContain(`--jq '.jobs[] | select(.conclusion == "success") | .name'`);
    expect(all.get("guard-visibility")).toContain("grep -qx verify-private;");
  });

  // `images` builds only the Pro image since 0.7.20; the public ones are built from kits in nouverse/nouride.
  for (const name of ["binaries", "images"]) {
    test(`builds no Pro row of ${name} from code that did not pass it — and the public rows do not wait on it`, () => {
      const job = all.get(name) ?? "";
      expect(job).toContain("needs: [verify, verify-private, guard-visibility]");
      // The job still runs when the gate failed, for its public rows; the Pro rows stop at their first step.
      expect(job).not.toContain("needs.verify-private.result == 'success' &&");
      expect(job).toContain("- name: The Pro code passed its gate\n        if: matrix.private");
      const gate = runOf(job, "The Pro code passed its gate");
      const result = (value: string) => spawnSync("sh", ["-c", gate], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RESULT: value } }).status;
      expect(result("success")).toBe(0);
      // Skipped only because ci.yml's run of it passed on this commit.
      expect(result("skipped")).toBe(0);
      expect(result("failure")).toBe(1);
      expect(result("cancelled")).toBe(1);
    });
  }
});

describe("the Pro half's release.yml", () => {
  // Found on a release: ci.yml had passed on the tagged commit, so the Pro half skipped `verify`, and GitHub then skipped
  // every job downstream of it that had no condition of its own. `build` had one and ran; `sign` and `boxes` did not, so
  // CHECKSUMS-pro went out with no signature and no box would install the release.
  const proRelease = "internals/pro/.github/workflows/release.yml";
  const pro = existsSync(join(ROOT, proRelease)) ? jobs(read(proRelease)) : null;

  test.skipIf(!pro)("signs and publishes to boxes after a build that ran with verify skipped", () => {
    expect(pro!.get("build")).toContain("needs.verify.result == 'skipped'");
    for (const [name, upstream] of [["sign", "build"], ["boxes", "sign"]] as const) {
      const job = pro!.get(name) ?? "";
      expect({ name, condition: /^ {4}if: .*$/m.exec(job)?.[0] ?? "" }).toEqual({
        name,
        condition: expect.stringContaining(`!cancelled() && needs.${upstream}.result == 'success'`),
      });
    }
  });
});

describe("the lints", () => {
  test("read the Pro code when it is there, and never the LLM gateway's", async () => {
    const files = (await lintedFiles(ROOT, ["ts", "tsx"])).map((path) => path.slice(ROOT.length + 1));
    expect(files.some((file) => file.startsWith("internals/nougate/"))).toBe(false);
    expect(files.some((file) => file.includes("/node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("internals/pro/"))).toBe(CHECKED_OUT);
  });

  test.skipIf(!CHECKED_OUT)("typecheck every Pro project it has, and name the packages it has none for", () => {
    const { projects, uncovered } = proProjects(ROOT);
    expect(projects).toContain("internals/pro/packages/oauth");
    expect(projects).toContain("internals/pro/packages/build-pro/flash");
    // A package is either a project or said to have none; never neither.
    for (const pkg of ["internals/pro/packages/appliance", "internals/pro/packages/multi-user", "internals/pro/packages/oauth"]) {
      expect(projects.some((project) => project === pkg || project.startsWith(`${pkg}/`)) !== uncovered.includes(pkg)).toBe(true);
    }
  });

  test("ask nothing of a clone without the submodule", () => {
    const empty = mkdtempSync(join(tmpdir(), "nouride-no-pro-"));
    try {
      expect(proProjects(empty)).toEqual({ projects: [], uncovered: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("check-types reads that list", () => {
    expect(read("scripts/check-types.ts")).toContain("...PRO.projects]");
  });
});
