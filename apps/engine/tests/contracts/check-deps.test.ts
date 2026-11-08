/**
 * `lint:deps` and the import rules left in `lint:arch` — each planted in the spelling that used to slip past.
 *
 * The package graph was a hand copy in `check-arch.ts` (`ALLOWED_DEPS`) that read no `package.json`: a package missing
 * from it could import anything, it allowed an edge no manifest declared, and it saw `from "…"` alone, so
 * `await import("@nouride/policy")` was never checked. Each case below is one of those, or the reverse direction the
 * contributing guide claimed was enforced and was not.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { depFindings, importsOf, workspaceMembers, type Manifest, type Member } from "../../../../scripts/check-deps.ts";

const ROOT = join(import.meta.dir, "../../../..");

const member = (dir: string, manifest: Omit<Manifest, "name"> & { name?: string }, files: Record<string, string>): Member => ({
  dir,
  manifest: { name: `@nouride/${dir.split("/").pop()}`, ...manifest },
  files: Object.entries(files).map(([path, text]) => ({ path: `${dir}/${path}`, text })),
});
const rules = (members: Member[], root?: Manifest) => depFindings(members, root, {}).map((f) => `${f.member} ${f.rule}`);

describe("lint:deps", () => {
  test("this tree holds", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;
    expect(depFindings(workspaceMembers(ROOT), manifest)).toEqual([]);
  });

  test("an import of a sibling the manifest does not declare is caught — dynamic and side-effect spellings too", () => {
    const shared = member("packages/shared", {}, { "src/index.ts": "export const x = 1;" });
    for (const text of [
      'import { x } from "@nouride/shared";',
      'const { x } = await import("@nouride/shared");',
      'import "@nouride/shared";',
      'export { x } from "@nouride/shared";',
    ]) {
      // `update` was absent from the old matrix, so it could import anything at all.
      const update = member("packages/update", { name: "nouride-update" }, { "src/index.ts": text });
      expect({ text, rules: rules([shared, update]) }).toEqual({ text, rules: ["packages/update imported-not-declared"] });
    }
  });

  test("an npm package a member imports and does not declare is caught; the root's own resolve from everywhere", () => {
    const llm = member("packages/llm", {}, { "src/a.ts": 'import ts from "typescript";\nimport { z } from "zod";' });
    expect(depFindings([llm], { name: "root", devDependencies: { typescript: "6" } }, {}).map((f) => f.detail)).toEqual([
      "packages/llm/src/a.ts imports the package zod, which packages/llm/package.json does not declare",
    ]);
  });

  test("a dependency nothing imports is caught — a test's import counts, a types package counts by its package's", () => {
    const persona = member(
      "packages/persona",
      { dependencies: { "@nouride/secrets": "workspace:*", d3: "1" }, devDependencies: { "@types/d3": "1", happy: "1" } },
      { "src/a.ts": 'import * as d3 from "d3";', "tests/a.test.ts": 'import "happy";' },
    );
    const secrets = member("packages/secrets", {}, {});
    expect(depFindings([persona, secrets], undefined, {}).map((f) => f.detail)).toEqual([
      "packages/persona/package.json declares @nouride/secrets, and nothing in packages/persona imports it",
    ]);
  });

  test("a word in a string or a comment is not an import, and a method named require is not either", () => {
    const text = '// from "left-pad"\nconst s = `import "nope"`;\nstore.require("nougate");\nconst t = \'removed from "x"\';';
    expect(importsOf("packages/secrets/tests/a.test.ts", text)).toEqual([]);
    expect(importsOf("apps/site/x.mjs", 'const sharp = require("sharp");')).toEqual(["sharp"]);
    expect(importsOf("apps/dashboard/src/index.css", '@import "tailwindcss";\n@plugin "daisyui";')).toEqual(["tailwindcss", "daisyui"]);
    expect(importsOf("apps/site/src/pages/a.astro", '---\nimport Layout from "@astrojs/starlight/x";\n---\n<p>import "no"</p>')).toEqual(["@astrojs/starlight"]);
    expect(importsOf("apps/engine/src/a.ts", 'import { x } from "@/modules/x.ts";\nimport "node:fs";\nimport "path";')).toEqual([]);
  });

  test("a plugin the build links is the engine's to import undeclared — and nobody else's", () => {
    const engine = member("apps/engine", { name: "@nouride/engine" }, { "src/a.ts": 'await import("nouride-update");' });
    const llm = member("packages/llm", {}, { "src/a.ts": 'await import("nouride-update");' });
    expect(rules([engine, llm])).toEqual(["packages/llm imported-not-declared"]);
  });

  test("a cycle among the members' dependencies is refused", () => {
    const a = member("packages/a", { dependencies: { "@nouride/b": "workspace:*" } }, { "src/i.ts": 'import "@nouride/b";' });
    const b = member("packages/b", { dependencies: { "@nouride/a": "workspace:*" } }, { "src/i.ts": 'import "@nouride/a";' });
    expect(depFindings([a, b], undefined, {}).map((f) => f.detail)).toEqual(["the dependencies go round: @nouride/a → @nouride/b → @nouride/a"]);
  });

  test("an exemption that excuses nothing any more is itself a finding", () => {
    const site = member("apps/site", { dependencies: { astro: "7" } }, { "astro.config.mjs": 'import { defineConfig } from "astro/config";' });
    expect(depFindings([site], undefined, { "apps/site": { astro: "the CLI", gone: "removed" } }).map((f) => f.rule)).toEqual(["stale-tooling", "stale-tooling"]);
  });
});

/** `check-arch.ts` run over a tree of its own: its scripts, the files planted, and the TypeScript its wire rules parse with. */
function archOver(files: Record<string, string>): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "nouride-arch-"));
  try {
    for (const script of ["check-arch.ts", "lint-sources.ts", "wire-rules.ts"]) {
      mkdirSync(join(root, "scripts"), { recursive: true });
      copyFileSync(join(ROOT, "scripts", script), join(root, "scripts", script));
    }
    writeFileSync(join(root, ".gitmodules"), "");
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const run = spawnSync(process.execPath, [join(root, "scripts/check-arch.ts")], { encoding: "utf8" });
    return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("lint:arch's import rules, in every spelling", () => {
  test("the dashboard importing a workspace package dynamically is caught", () => {
    const { code, out } = archOver({ "apps/dashboard/src/a.ts": 'export const m = await import("@nouride/shared");\n' });
    expect(code).toBe(1);
    expect(out).toContain("[dashboard-imports-workspace]");
  });

  test("the dashboard may import the wire's types, by `import type` alone", () => {
    const wire = { "packages/wire/src/index.ts": "export interface User { id: string }\n" };
    expect(archOver({ ...wire, "apps/dashboard/src/a.ts": 'import type { User } from "@nouride/wire";\nexport const id = (u: User) => u.id;\n' })).toMatchObject({ code: 0 });
    const { code, out } = archOver({ ...wire, "apps/dashboard/src/a.ts": 'import { User } from "@nouride/wire";\nexport const id = (u: User) => u.id;\n' });
    expect(code).toBe(1);
    expect(out).toContain("[wire-imported-as-value]");
    expect(out).not.toContain("[dashboard-imports-workspace]");
  });

  test("shared importing a sibling for its side effect is caught", () => {
    const { code, out } = archOver({ "packages/shared/src/a.ts": 'import "@nouride/runtime";\n' });
    expect(code).toBe(1);
    expect(out).toContain("[shared-imports-workspace]");
  });

  test("browser code reached from a non-ui package through require is caught — and a clean tree passes", () => {
    // Spelled in pieces, or lint:arch would read this very line as the engine importing browser code.
    const ui = ["@nouride", "ui-graph"].join("/");
    const { out } = archOver({ "packages/llm/src/a.ts": `export const g = require("${ui}");\n` });
    expect(out).toContain("[ui-outside-the-dashboard]");
    expect(archOver({ "packages/llm/src/a.ts": "export const x = 1;\n" })).toMatchObject({ code: 0 });
  });

  // The names are put in from outside each line, or lint:arch would read these very lines as copies.
  test("a text helper written again outside @nouride/shared is refused, as a function or an arrow", () => {
    for (const copy of [
      `function ${"clip"}(text: string, max: number): string {\n  return text.slice(0, max);\n}\nexport const x = clip('a', 1);\n`,
      `const ${"oneLine"} = (text: string): string => text.trim();\nexport const x = oneLine('a');\n`,
      `export const ${"plural"} = (n: number, one: string) => (n === 1 ? one : one + "s");\n`,
    ]) {
      const { code, out } = archOver({ "packages/llm/src/a.ts": copy });
      expect(code).toBe(1);
      expect(out).toContain("[reimplemented-formatter]");
    }
  });

  test("a value that is only named like one, and the dashboard's own copy, are not", () => {
    expect(archOver({ "packages/llm/src/a.ts": "export const clip = await Promise.resolve(1);\n" })).toMatchObject({ code: 0 });
    expect(archOver({ "apps/dashboard/src/a.ts": `export function ${"clip"}(text: string): string {\n  return text;\n}\n` })).toMatchObject({ code: 0 });
  });
});
