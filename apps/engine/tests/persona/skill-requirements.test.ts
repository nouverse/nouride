/**
 * `requires:` — host software a skill's procedure needs.
 *
 * Advisory by design: nothing here gates loading. What it must get right is the answer, because the
 * failure it exists to prevent is an agent four steps into a task hitting `dot: command not found`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Skill } from "@nouride/shared";
import { checkSkillSoftware, checkSoftware, clearSoftwareCache, missingFor } from "@nouride/persona";

function skill(name: string, requires?: string[]): Skill {
  return { name, description: "d", path: `/pool/${name}/SKILL.md`, scope: "shared", ...(requires ? { requires } : {}) };
}

beforeEach(() => {
  clearSoftwareCache();
});

describe("checkSoftware", () => {
  test("finds a program that is on PATH", () => {
    // `sh` rather than something interesting: this asserts the probe works, and every host running
    // these tests has a shell.
    const result = checkSoftware("sh");
    expect(result.present).toBe(true);
    expect(result.path).toContain("sh");
  });

  test("reports a program that is not installed", () => {
    expect(checkSoftware("nouride-definitely-not-installed").present).toBe(false);
  });

  test("a name that is not a bare program name is refused, not looked up", () => {
    // `Bun.which` resolves relative paths, so a `requires:` field naming one would probe the
    // daemon's cwd — and frontmatter is not a place to accept a path.
    expect(checkSoftware("../../bin/sh").present).toBe(false);
    expect(checkSoftware("/bin/sh").present).toBe(false);
  });

  test("answers from cache within the TTL", () => {
    const first = checkSoftware("sh");
    // Same object identity: the second call did not walk PATH again, which is what makes a polling
    // dashboard free.
    expect(checkSoftware("sh")).toBe(first);
  });
});

describe("what a skill is missing", () => {
  test("a skill that names nothing is missing nothing", () => {
    expect(missingFor(skill("plain"))).toEqual([]);
  });

  test("only the absent programs are reported", () => {
    expect(missingFor(skill("graphs", ["sh", "nouride-definitely-not-installed"]))).toEqual([
      "nouride-definitely-not-installed",
    ]);
  });

  test("the summary checks each distinct program once", () => {
    const checks = checkSkillSoftware([
      skill("a", ["sh", "nouride-definitely-not-installed"]),
      skill("b", ["sh"]),
      skill("c"),
    ]);

    // Deduplicated: four skills wanting graphviz is one missing package, and the Workshop says it
    // once rather than putting the same warning on four rows.
    expect(checks.map((entry) => entry.name)).toEqual(["nouride-definitely-not-installed", "sh"]);
  });
});
