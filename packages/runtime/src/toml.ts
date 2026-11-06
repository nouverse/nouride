/**
 * TOML loading via `Bun.TOML.parse` — zero dependencies (TD-001, §7 ARCHITECTURE).
 *
 * **Not** `import("…toml")`, which is what this used to do. Bun's module loader parses TOML, but
 * it caches the result by path and ignores both a `?v=` query and a `#fragment`, so a file edited
 * and re-read in the same process returned the *previous* parse — permanently. Hot reload, the
 * `/reload` hook and every config-writing tool silently kept working from stale config, which is
 * the exact failure the cache-busting was meant to prevent.
 *
 * Reading the text and parsing it explicitly has no cache to defeat, and is simpler.
 */

import { readTextFile, statFile } from "./fs.ts";

export async function loadToml<T>(path: string): Promise<T> {
  if (!statFile(path)) throw new Error(`toml file not found: ${path}`);
  const source = await readTextFile(path);
  return Bun.TOML.parse(source) as T;
}

export async function loadTomlIfExists<T>(path: string): Promise<T | null> {
  return statFile(path) ? await loadToml<T>(path) : null;
}

/** Parse TOML already in memory — used by tests and by anything that has the text already. */
export function parseToml<T>(source: string): T {
  return Bun.TOML.parse(source) as T;
}
