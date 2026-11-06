/**
 * Which tracked files are published — one answer, read by `check-public.ts`.
 *
 * Since 2026-11-06 this repository is public (`nouverse/nouride`), so everything it tracks is published but
 * `internals/`, the private submodules: the Pro code and its tooling, the internal docs, and the agent skills, which
 * describe the homelab (`.agents/skills` is a link into `internals/pro`).
 *
 * `content/` is a submodule too, but a public one (`nouverse/nouride-builtin-contents`, 0.8.12): its files are published
 * as files, and checked as every other published file is. It has to be checked out, or the check would pass over them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../", import.meta.url).pathname;

export const PRIVATE = ["internals/"];

/** Submodule paths from `.gitmodules`, with their URLs. */
export async function submodules(): Promise<{ path: string; url: string; name: string }[]> {
  // The public export has none: its one public submodule, `content/`, is copied in as files.
  const file = Bun.file(join(ROOT, ".gitmodules"));
  if (!(await file.exists())) return [];
  const text = await file.text();
  return [...text.matchAll(/\[submodule "([^"]+)"\]\s*\n\s*path\s*=\s*(\S+)\s*\n\s*url\s*=\s*(\S+)/g)].map((m) => ({ name: m[1]!, path: m[2]!, url: m[3]! }));
}

/** Submodules that are public repositories, whose files are published with the rest. */
const PUBLIC_SUBMODULES = ["content"];

export async function publicFiles(): Promise<{ files: string[]; left: string[] }> {
  const subs = await submodules();
  const left = [...PRIVATE, ...subs.filter((s) => !PUBLIC_SUBMODULES.includes(s.path)).map((s) => `${s.path}/`)];
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
  // A submodule is listed as its own path, with no slash after it.
  const files = listed.filter((rel) => !left.some((dir) => rel.startsWith(dir) || `${rel}/` === dir) && !PUBLIC_SUBMODULES.includes(rel));
  // Without git's own variables: a commit hook sets `GIT_INDEX_FILE` to the superproject's index, and the submodule's
  // `ls-files` would read that one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  for (const path of PUBLIC_SUBMODULES.filter((p) => subs.some((s) => s.path === p))) {
    if (!existsSync(join(ROOT, path, ".git"))) throw new Error(`${path}/ is not checked out — \`git submodule update --init ${path}\` first`);
    const own = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: join(ROOT, path), env }).stdout.toString().split("\0").filter(Boolean);
    files.push(...own.map((rel) => `${path}/${rel}`));
  }
  return { files, left };
}
