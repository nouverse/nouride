/**
 * Which tracked files are published — one answer, read by `check-public.ts`.
 *
 * Since 2026-11-06 this repository is public (`nouverse/nouride`), so everything it tracks is published but
 * `internals/` and every submodule: the Pro code and its tooling, the internal docs, and the agent skills that
 * describe the homelab (each a link in `.agents/skills` into `internals/pro`; the public ones are written there).
 * */

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


export async function publicFiles(): Promise<{ files: string[]; left: string[] }> {
  const left = [...PRIVATE, ...(await submodules()).map((s) => `${s.path}/`)];
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
  // A submodule is listed as its own path, with no slash after it.
  const files = listed.filter((rel) => !left.some((dir) => rel.startsWith(dir) || `${rel}/` === dir));
  return { files, left };
}
