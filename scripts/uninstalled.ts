/**
 * An import that does not resolve because an install has not run, told from one that is wrong — for the checks that
 * compile code a plugin installs apart from this workspace: `check-seams` and `check-types`.
 *
 * Nougate and the Pro tree keep their own lockfiles, and the root `bun install` does not reach them. In a fresh clone
 * their sources import packages from nowhere, and each check said so once per import, as if the code were broken —
 * `lint:types` with a bare TS2307 for `internals/pro/appliance` and nothing about why (fresh-checkout-hook).
 *
 * This file is itself tooling, so it is exempt from the Bun and Node rules the engine follows.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** `dir`, then each directory above it up to `root` — none when `dir` is not under `root`. */
function upFrom(dir: string, root: string): string[] {
  const out: string[] = [];
  for (let at = dir; at === root || at.startsWith(`${root}/`); at = dirname(at)) {
    out.push(at);
    if (at === root) break;
  }
  return out;
}

/**
 * The install an import that does not resolve is waiting for, or null when it is the import that is wrong.
 *
 * That case is a bare package the nearest manifest above the importing file declares, with no copy in a `node_modules`
 * from there up; the install is run in the nearest directory with a lockfile, from that manifest up — `dir`, relative
 * to `root`.
 */
export function uninstalledAt(file: string, specifier: string, root = ROOT): { dir: string; pkg: string } | null {
  if (/^[./]/.test(specifier) || specifier.includes(":")) return null;
  const pkg = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const manifest = upFrom(dirname(file), root).find((dir) => existsSync(join(dir, "package.json")));
  if (manifest === undefined) return null;
  const declared = JSON.parse(readFileSync(join(manifest, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  if (!["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((field) => declared[field]?.[pkg])) return null;
  const above = upFrom(manifest, root);
  if (above.some((dir) => existsSync(join(dir, "node_modules", pkg)))) return null;
  const lockfile = above.find((dir) => existsSync(join(dir, "bun.lock")));
  return lockfile === undefined ? null : { dir: relative(root, lockfile) || ".", pkg };
}

/**
 * The installs `tsc`'s output is waiting for, by where to run each: its TS2307 lines whose module `uninstalledAt` names
 * an install for. File paths in the output are relative to `root`, where `tsc` ran.
 */
export function installsInTsc(output: string, root = ROOT): Map<string, Set<string>> {
  const missing = new Map<string, Set<string>>();
  for (const [, file, specifier] of output.matchAll(/^(.+?)\(\d+,\d+\): error TS2307: Cannot find module '([^']+)'/gm)) {
    const install = uninstalledAt(resolve(root, file!), specifier!, root);
    if (install) missing.set(install.dir, (missing.get(install.dir) ?? new Set<string>()).add(install.pkg));
  }
  return missing;
}

/** What a directory's missing install stops — nothing coming through it can be `done` — and the command that installs it without touching its lockfile. */
export function notInstalled(dir: string, packages: string[], done: string): string {
  const one = packages.length === 1;
  return (
    `${dir}: its dependencies are not installed — ${packages.map((pkg) => `\`${pkg}\``).join(", ")} ${one ? "does" : "do"} not resolve, ` +
    `so nothing that comes through ${one ? "it" : "them"} can be ${done}. Run \`bun install --frozen-lockfile\` in ${dir}, then this ` +
    "check again — frozen, the install takes what the lockfile pins and writes nothing"
  );
}
