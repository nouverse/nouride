/**
 * Every call the API client offers has a caller.
 *
 * Four wrappers sat in `commons/lib` from the day they were written with nothing calling them:
 * `restartGateway`, `pruneSessions`, `editSkillDraft` and `memoryTags`. They read like features — pruning
 * history, editing a draft — that no screen offers, and they kept a destructive admin route looking used.
 * `lint:deadcode` cannot see them, because it reads top-level exports and these are members of one, so
 * the check lives here: each member of each `*Api` object is called from a file that is not itself
 * part of the client.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(import.meta.path), "..", "src");
const LIB = join(SRC, "commons", "lib");

/** The client's own files: `api.ts` and every `api.*.ts` beside it. A call from one of them is not a caller. */
const isClientFile = (path: string) => dirname(path) === LIB && /^api(\.[\w-]+)?\.ts$/.test(path.slice(LIB.length + 1));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

/**
 * Each exported object of calls, read from the module itself so a spread (`...memoryApi`) is counted where it
 * lands. Every one of them is reached as `api.x` or `somethingApi.x` — the box pages import theirs `as api`.
 */
async function members(): Promise<{ file: string; name: string }[]> {
  const found: { file: string; name: string }[] = [];
  for (const path of sources(LIB).filter(isClientFile)) {
    const module = (await import(path)) as Record<string, unknown>;
    for (const [exported, value] of Object.entries(module)) {
      if (!/^(api|\w+Api)$/.test(exported) || typeof value !== "object" || value === null) continue;
      // Only what this file declares: `api` spreads the others, and they are checked where they are written.
      const declared = readFileSync(path, "utf8");
      for (const [name, member] of Object.entries(value)) {
        if (typeof member === "function" && new RegExp(`^\\s+${name}\\s*[:(]`, "m").test(declared)) {
          found.push({ file: relative(SRC, path), name });
        }
      }
    }
  }
  return found;
}

describe("the API client", () => {
  test("has calls to check, so the rest of this means something", async () => {
    // The fail-open shape: a module that stopped being read would make the check below pass.
    expect((await members()).length).toBeGreaterThan(150);
  });

  test("offers nothing that no page calls", async () => {
    // Whitespace allowed around the dot: a chained call is written `api\n  .chatUpload(picked)`.
    const called = new Set(
      sources(SRC)
        .filter((path) => !isClientFile(path))
        .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/\b(?:api|\w+Api)\s*\.\s*(\w+)/g)].map((m) => m[1]!)),
    );
    const uncalled = (await members()).filter(({ name }) => !called.has(name)).map(({ file, name }) => `${file}: ${name}`);
    expect(uncalled).toEqual([]);
  });
});
