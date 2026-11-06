/**
 * Every error class in the tree names itself with a literal, because a release build mangles the class.
 *
 * `scripts/error-names.ts` says why. Read from git's own file list, so a new package is covered the day it is
 * added — and the Pro tree when it is checked out, since its plugins are linked into the Pro binaries and log
 * through the same journal.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorClasses, unnamedErrorClasses } from "../../../../scripts/error-names.ts";

const ROOT = join(import.meta.dir, "../../../..");

function tracked(cwd: string, prefix: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx"], { cwd, encoding: "utf8" });
  return listed
    .split("\0")
    .filter(Boolean)
    .filter((rel) => !rel.endsWith(".d.ts") && !/\.test\.tsx?$/.test(rel) && !/(^|\/)tests?\//.test(rel))
    .map((rel) => `${prefix}${rel}`);
}

function sources(): { file: string; text: string }[] {
  const files = tracked(ROOT, "");
  if (existsSync(join(ROOT, "internals/pro/package.json"))) files.push(...tracked(join(ROOT, "internals/pro"), "internals/pro/"));
  return files.map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
}

describe("error class names", () => {
  test("every error class in the tree names itself, as itself", () => {
    const all = sources();
    // The walk has to have found the classes it guards, or an empty list would pass for the wrong reason.
    const names = errorClasses(all).map((cls) => cls.name);
    expect(names).toEqual(expect.arrayContaining(["NourideError", "ConfigError", "GatewayAuthError", "ToolError", "HubError"]));
    expect(unnamedErrorClasses(all)).toEqual([]);
  });

  test("an unnamed one is found however far from Error it sits, and so is a wrong or anonymous one", () => {
    const fixture = [
      `class Base extends Error { override name = "Base"; }`,
      `class Middle extends Base { constructor() { super(); this.name = "Middle"; } }`,
      `export class Leaf extends Middle {}`,
      `class Copied extends errors.Base { override name = "Middle"; }`,
      `const Anonymous = class extends TypeError {};`,
      `class NotAnError extends Map {}`,
    ].join("\n");
    expect(unnamedErrorClasses([{ file: "x.ts", text: fixture }])).toEqual([
      `x.ts:3: Leaf says no name — add \`override name = "Leaf";\``,
      `x.ts:4: Copied calls itself "Middle"`,
      `x.ts:5: an anonymous class extends TypeError — give it a name and a \`name = "…"\` field`,
    ]);
  });

  test("a name set anywhere but the class's own body does not count", () => {
    const fixture = [
      `class Late extends Error {}`,
      `Late.prototype.name = "Late";`,
      `class Computed extends Error { constructor() { super(); this.name = new.target.name; } }`,
      `class Static extends Error { static readonly label = "Static"; }`,
    ].join("\n");
    expect(unnamedErrorClasses([{ file: "x.ts", text: fixture }]).map((line) => line.split(" ")[1])).toEqual([
      "Late",
      "Computed",
      "Static",
    ]);
  });
});
