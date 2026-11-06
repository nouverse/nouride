import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToml, loadTomlIfExists, removePath, writeTextFileAtomic } from "../src/index.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-toml-"));
  path = join(dir, "config.toml");
});

afterEach(() => {
  removePath(dir);
});

describe("loadToml", () => {

  test("re-reads a file that changed in this process", async () => {
    // The bug this pins: `import("…toml")` caches by path and ignores `?v=` and `#frag`, so an
    // edited file returned its *previous* parse for the lifetime of the process. Hot reload,
    // `/reload` and every config-writing tool silently kept using stale config.
    await writeTextFileAtomic(path, '[skills]\nshared = []\n');
    expect((await loadToml<any>(path)).skills.shared).toEqual([]);

    await writeTextFileAtomic(path, '[skills]\nshared = ["github"]\n');
    expect((await loadToml<any>(path)).skills.shared).toEqual(["github"]);
  });

  test("re-reads correctly even when two writes land in the same millisecond", async () => {
    // Cache-busting on mtime would also have been defeated by coarse timestamp resolution; not
    // caching at all has no such edge.
    await writeTextFileAtomic(path, "n = 1\n");
    await writeTextFileAtomic(path, "n = 2\n");
    expect((await loadToml<any>(path)).n).toBe(2);
  });

  test("throws on a missing file", async () => {
    await expect(loadToml(join(dir, "nope.toml"))).rejects.toThrow(/not found/);
  });

  test.each([
    ["a value with nothing after it", "a = \n"],
    ["a missing key", "= 1\n"],
    ["an unterminated string", "a = 'oops\n"],
    ["a bare word where a pair belongs", "a = 1\nb\n"],
  ])("throws on %s rather than returning a partial object", async (_label, source) => {
    await writeTextFileAtomic(path, source);
    await expect(loadToml(path)).rejects.toThrow();
  });

  test.each([
    ["anything follows it", '[daemon\nname = "nouride"\n'],
    // Bun <=1.3 parsed a bare `[daemon` at end of file as an empty table — harmless, but it made
    // the strictness above look partial. Bun 1.4 rejects it too, so the whole shape is now one rule.
    ["the file ends right after it", "[daemon\n"],
  ])("a table header missing its bracket fails when %s", async (_label, source) => {
    await writeTextFileAtomic(path, source);
    await expect(loadToml(path)).rejects.toThrow();
  });
});

describe("loadTomlIfExists", () => {
  test("returns null for a missing file", async () => {
    expect(await loadTomlIfExists(join(dir, "nope.toml"))).toBeNull();
  });

  test("parses when present", async () => {
    await writeTextFileAtomic(path, "x = 1\n");
    expect(await loadTomlIfExists<any>(path)).toEqual({ x: 1 });
  });
});
