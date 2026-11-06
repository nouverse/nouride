/**
 * The skills this repository actually ships, checked as content.
 *
 * Every other test in this area uses fixtures, which proves the loader works and proves nothing
 * about what we release. A skill with a malformed frontmatter block loads as a nameless entry with
 * an empty description — no error, no warning, just an agent that never reaches for it. That is
 * exactly the failure a fixture-only suite cannot see.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@nouride/persona";
import { CANDIDATES, resolveBuiltinSkillsDir } from "@nouride/persona";

const dir = resolveBuiltinSkillsDir();

/**
 * Carried in every prompt, for every agent, on every turn — only the body is loaded on demand
 * (§6.3 SPEC). A generous ceiling rather than a style rule: the point is to fail before a
 * description grows into a paragraph, not to argue about a sentence.
 */
// 500 since network-reach, whose description has to name the kinds of device it reaches for the
// model to pick it — a camera or a phone is not "another machine" to it otherwise.
const MAX_DESCRIPTION = 500;

describe("the skills we ship", () => {
  test("the directory is found from a checkout", () => {
    // If this fails in CI, `skills/` is missing or the resolver stopped looking in the working
    // directory — and every deployment would silently have no built-in skills.
    expect(dir).toBeDefined();
  });

  const names = dir
    ? readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())
    : [];

  test("there is at least one", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  test("both deployment shapes are still searched", () => {
    // Two names for one directory, and neither is redundant: an install has it flattened beside the
    // executable (`skills/`, staged by `scripts/build/core.ts` and by the Dockerfile's COPY), a checkout has
    // it under `content/`. Tidying this list down to one entry would leave the other shape with no
    // built-in skills and nothing in the log to say so — the exact silence this file exists to catch.
    expect(CANDIDATES).toContain("skills");
    expect(CANDIDATES).toContain("content/skills");
  });

  for (const name of names) {
    describe(name, () => {
      const source = readFileSync(join(dir as string, name, "SKILL.md"), "utf8");
      const { fields, body } = parseFrontmatter(source);

      test("has frontmatter naming itself after its directory", () => {
        // The loader falls back to the directory name when `name:` is absent, so a mismatch is not
        // a crash — it is a skill the operator disables by one name and the agent still lists under
        // another.
        expect(fields.name).toBe(name);
      });

      test("has a description, and a short one", () => {
        expect(fields.description ?? "").not.toBe("");
        expect((fields.description ?? "").length).toBeLessThanOrEqual(MAX_DESCRIPTION);
      });

      test("has a body", () => {
        // Frontmatter with nothing under it is a skill the model can find and cannot read.
        expect(body.trim().length).toBeGreaterThan(0);
      });

      test("every script it tells the agent to run ships beside it", () => {
        // The agent runs `python3 <this skill's directory>/scripts/<name>`; a renamed script would leave the skill
        // sending it to a file that is not there, on every install.
        for (const [, script] of body.matchAll(/`(scripts\/[\w.-]+)`/g)) {
          expect({ skill: name, script, exists: existsSync(join(dir as string, name, script as string)) }).toEqual({ skill: name, script, exists: true });
        }
      });
    });
  }

  /**
   * A machine too small to render is the case this skill is for as much as a big one: it has to
   * know where to go instead. The hand-off is by name, so renaming network-reach would leave it
   * pointing at nothing and the agent telling the person to find a better computer themselves.
   */
  describe("the motion-graphics skill", () => {
    const source = dir ? readFileSync(join(dir, "motion-graphics", "SKILL.md"), "utf8") : "";

    test("checks the machine before installing anything", () => {
      expect(source.indexOf("## 1. Can this machine render?")).toBeGreaterThan(-1);
      expect(source.indexOf("## 1. Can this machine render?")).toBeLessThan(source.indexOf("npm i "));
    });

    test("hands a render it cannot do to a skill that exists", () => {
      expect(source).toContain("`network-reach` skill");
      expect(names).toContain("network-reach");
    });
  });

  /**
   * `playwright-cli` echoes the code it ran after every command, and for `fill` that code carries
   * the value — a password filled without `--raw` lands in the model's context and the log. Checked
   * against 0.1.22; this holds the example in the skill to it.
   */
  describe("the browser-automation skill", () => {
    const source = dir ? readFileSync(join(dir, "browser-automation", "SKILL.md"), "utf8") : "";

    test("fills secrets with --raw", () => {
      const secretFills = source.match(/playwright-cli[^\n]*fill[^\n]*"\$[A-Z_]+"/g) ?? [];
      expect(secretFills.length).toBeGreaterThan(0);
      for (const line of secretFills) expect(line).toContain("--raw");
    });

    test("hands a machine that cannot run a browser to a skill that exists", () => {
      expect(source).toContain("`network-reach` skill");
      expect(names).toContain("network-reach");
    });
  });

  /**
   * The one skill that is about the product, held to the rule it exists to enforce.
   *
   * It was written because an agent drafted its own version of it — `nouride-daemon-update`, half
   * copied from the system prompt and half from `nouride update --help`. Shipping a skill is the
   * fix, and it is also the way to make the same mistake at the source: a shipped file that lists
   * flags is a hand-kept copy of `--help` like any other, except this one goes out in the release.
   *
   * So the file has to carry the two things that keep it honest, and they are asserted rather than
   * trusted: it must send the reader to `--help` for flags, and it must say that its own silence is
   * not evidence a feature is missing. Hermes ships the same two clauses on its `hermes-agent`
   * skill, for the same reason.
   */
  describe("the skill about Nouride itself", () => {
    const source = dir ? readFileSync(join(dir, "nouride", "SKILL.md"), "utf8") : "";

    test("is shipped at all", () => {
      // Without it, triage has nothing to point at when a lesson is about operating the daemon, and
      // `create` is the honest answer to "does an existing skill cover this?".
      expect(source).not.toBe("");
    });

    test("sends the reader to --help for flags rather than listing them", () => {
      expect(source).toContain("--help");
      /**
       * A ceiling, not a ban. Two flags change what a command *means* — `--help` turns a command into
       * its own reference, `--then` is the one `restart` is refused without — and a procedure cannot be
       * written without naming them. A file that names a dozen has stopped being a procedure and become
       * a reference, which is the thing that goes stale. (Upgrading names none since 0.8.12: it is the
       * `update` tool's.)
       */
      const flags = [...new Set(source.match(/`--[a-z][a-z-]*`/g) ?? [])];
      expect(flags.filter((flag) => !["`--help`", "`--then`"].includes(flag))).toEqual([]);
      expect(flags).toContain("`--then`");
    });

    test("says its own silence is not evidence", () => {
      // The clause that stops it being read as the complete truth about Nouride. Without it an agent
      // answers "Nouride cannot do that" from a file that was never meant to be exhaustive.
      expect(source).toContain("not evidence it does not exist");
    });

    /**
     * Updating goes through the `update` tool (0.8.12): `check`, then `apply` with a `then` it refuses to go without.
     * The skill sent the agent to the `nouride` tool's `update` and its `--then`, which the tool's own description
     * says not to use — and the tool is what schedules the way back before the restart.
     */
    test("upgrades with the update tool: check, then apply with then", () => {
      const upgrading = source.slice(source.indexOf("## Upgrading"), source.indexOf("## Restarting")).replace(/\s+/g, " ");
      expect(upgrading).toContain("Do it with the `update` tool, not with the `nouride` tool's `update`");
      expect(upgrading).toContain("`update` with action `check` reports what is available and changes nothing");
      expect(upgrading).toContain("Action `apply` is the one that replaces the binary");
      expect(upgrading).toContain("`apply` needs `then`, what you will check when you are back");
      expect(upgrading).not.toContain("--then");
    });
  });

  /**
   * Python writes its bytecode cache beside a skill's script whenever something imports it. Two were committed under
   * `content/skills`, which the build copies whole into every release; git ignores them since 0.8.12.
   */
  test("no Python bytecode is tracked among them, and git ignores it", () => {
    const root = join(import.meta.dir, "../../../..");
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "content/skills"], { cwd: root, encoding: "utf8" }).split("\0");
    expect(tracked.filter((path) => /(^|\/)__pycache__\/|\.pyc$/.test(path))).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/^__pycache__\/$/m);
  });
});
