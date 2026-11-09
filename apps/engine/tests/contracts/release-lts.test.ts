/**
 * A patch to a long-term line (0.8.18): `[lts]` in the tag's message publishes it without moving
 * `latest` anywhere, tags its images `lts`, starts the public half in the same mode, and refuses `[quiet]` beside it.
 * The release before it, which its notes are written against, is the highest version below it, not the highest tag:
 * for a 1.0.x cut after 1.1.0 that was 1.1.0.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");

describe("a long-term patch", () => {
  test("is read from the tag's message, and refused beside [quiet]", () => {
    expect(workflow).toContain(`if printf '%s' "\${message}" | grep -q '\\[lts\\]'; then`);
    expect(workflow).toContain("says both [quiet] and [lts]");
    expect(workflow).toContain('echo "lts=yes" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("lts: ${{ steps.quiet.outputs.lts }}");
  });

  test("is published, not a pre-release, and not GitHub's latest", () => {
    expect(workflow).toContain('if [ "${LTS}" = "yes" ]; then visibility="--latest=false"; fi');
  });

  test("its images are tagged lts and never latest", () => {
    expect(workflow).toContain(
      "type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') && needs.guard-visibility.outputs.quiet != 'yes' && needs.guard-visibility.outputs.lts != 'yes' }}",
    );
    expect(workflow).toContain("type=raw,value=lts,enable=${{ startsWith(github.ref, 'refs/tags/v') && needs.guard-visibility.outputs.lts == 'yes' }}");
    // `{{major}}.{{minor}}` is the line's floating tag, `1.0`, which every release already gets.
    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}}");
  });

  test("the public half is started in the same mode", () => {
    expect(workflow).toContain('-f quiet="${QUIET:-no}" -f lts="${LTS:-no}"');
  });
});

describe("the release before this one", () => {
  // The workflow's own line, run as it is.
  const line = /^\s*prev=\$\(git tag --sort=-v:refname \| (awk .*)\)$/m.exec(workflow)?.[1];
  const previous = (current: string, tags: string[]) =>
    spawnSync("sh", ["-c", `printf '%s\\n' "$@" | sort -r -V | ${line!.replace("${GITHUB_REF_NAME}", current)}`, "sh", ...tags], { encoding: "utf8" }).stdout.trim();
  const TAGS = ["v0.8.24", "v1.0.0", "v1.0.7", "v1.0.8", "v1.1.0", "v1.1.1"];

  test("is the highest version below it, for a long-term patch cut after a newer line", () => {
    expect(line).toBeDefined();
    expect(previous("v1.0.8", TAGS)).toBe("v1.0.7");
    expect(previous("v1.0.0", TAGS)).toBe("v0.8.24");
  });

  test("is the one before the newest for an ordinary release, as before, and none for the first", () => {
    expect(previous("v1.1.1", TAGS)).toBe("v1.1.0");
    expect(previous("v0.8.24", TAGS)).toBe("");
  });
});

describe("a long-term line's maintenance branch", () => {
  test("is tested as a release branch is: ci.yml runs on lts/**", () => {
    const ci = readFileSync(join(import.meta.dir, "../../../../.github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('branches: ["main", "releases/**", "lts/**"]');
  });
});

