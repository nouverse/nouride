/**
 * Which source the lints read — one answer, for `check-arch`, `check-sql`, `check-size`, `check-deadcode` and
 * `check-types`.
 *
 * This repository's `apps/` and `packages/`, and the Pro code when the private submodule is checked out. The Box
 * editions are built from `internals/pro`, and every one of these lints read only `{apps,packages}`, so about 3,600
 * lines of shipped code were held to none of the rules the rest is — no typecheck, no size ratchet, no dead-export
 * rule, no SQL rules — which the 2026-10-16 audit found (`pro-no-automated-gate`). Absent from a public clone, where
 * the Pro half is simply empty.
 *
 * `internals/nougate` is not read: it is another product, with rules and a test command of its own.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** `from "x"`, `import "x"`, `import("x")`, `require("x")` — capture group 1 is the specifier. */
export const MODULE_SPECIFIER = /(?:from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** The Pro code's root, for the rules that treat it differently from the engine. */
export const PRO = "internals/pro/";

const SOURCES = ["{apps,packages}/**/*", `${PRO}**/*`];

/** Every source file with one of `extensions`, absolute and sorted, `node_modules` left out. */
export async function lintedFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const source of SOURCES) {
    for await (const path of new Bun.Glob(`${source}.{${extensions.join(",")}}`).scan({ cwd: root, absolute: true })) {
      if (path.includes("/node_modules/")) continue;
      files.push(path);
    }
  }
  return files.sort();
}

/** Every directory under `dir` holding a `tsconfig.json`, relative to `root` — `node_modules` and dot-directories left out. */
function tsconfigDirs(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsconfigDirs(root, path));
    else if (entry.name === "tsconfig.json") found.push(relative(root, dir));
  }
  return found;
}

/**
 * This repository's own TypeScript projects: every `tsconfig.json` under `apps/`, `packages/` and `scripts/`.
 *
 * Found rather than listed, for the reason `proProjects` gives. The list `check-types` kept by hand had fifteen entries
 * and nothing to say what it missed, which was the dashboard's tests (a fixture still shaped like a person before
 * `id` became `key`), the WhatsApp bridge's tests, the root `scripts/` (the release tooling included) and the site's
 * scripts — none of them checked by anything, because `bun test` and `bun run` do not typecheck.
 */
export function publicProjects(root: string): string[] {
  return ["apps", "packages", "scripts"].flatMap((top) => tsconfigDirs(root, join(root, top))).sort();
}

/**
 * Projects with a `tsconfig.json` that `tsc` is not the tool for, and why. `check-types` says each one on every run, so
 * the gap stays in view.
 *
 * `apps/site` is Astro's: its pages import `astro:content` and the other `astro:*` modules, whose types `astro sync`
 * writes into a `.astro/` directory a clone does not have. `bun run lint:site` (`astro check`) typechecks them, in
 * `verify` and CI rather than the commit hook: it syncs the content collections first, about half a minute of CPU,
 * which would add a quarter to every commit for pages most commits do not touch. Its build scripts are ordinary Bun
 * code and a project of their own, `apps/site/scripts`, which is checked here.
 */
export const NOT_FOR_TSC: Readonly<Record<string, string>> = {
  "apps/site": "its pages are typechecked by `bun run lint:site` (astro check), in verify and CI; its scripts are apps/site/scripts",
};

/**
 * The Pro code's TypeScript projects: every `tsconfig.json` under it, and its packages that have none.
 *
 * Found rather than listed, because which projects that repository has is its own decision: a package that adds a
 * `tsconfig.json` is checked from then on with no edit here. One that has none is named, so the gap is said rather
 * than passed over. Both empty when the submodule is not checked out.
 */
export function proProjects(root: string): { projects: string[]; uncovered: string[] } {
  const pro = join(root, PRO);
  if (!existsSync(join(pro, "package.json"))) return { projects: [], uncovered: [] };
  const projects = tsconfigDirs(root, pro);
  const packages = readdirSync(pro, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(pro, entry.name, "package.json")))
    .map((entry) => `${PRO}${entry.name}`);
  return {
    projects: projects.sort(),
    uncovered: packages.filter((dir) => !projects.some((project) => project === dir || project.startsWith(`${dir}/`))),
  };
}
