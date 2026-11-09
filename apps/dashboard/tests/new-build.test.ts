/**
 * A tab older than the build the daemon serves (`commons/lib/new-build.ts`): its chunks are gone after an upgrade, and
 * nothing reloaded it — the memory graph failed to load until someone reloaded the tab by hand.
 */

import { describe, expect, test } from "bun:test";
import { isChunkLoadError, reloadForNewBuild } from "@/commons/lib/new-build";

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe("a chunk that is gone", () => {
  test("is told from any other error, in each browser's words", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://box/dashboard/assets/graph.page-B9.js",
      "error loading dynamically imported module: https://box/dashboard/assets/graph.page-B9.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /dashboard/assets/graph.page-B9.css",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'length')"))).toBe(false);
  });

  test("reloads the tab once — a chunk missing from the new build too does not reload it for ever", () => {
    const storage = memory();
    let reloads = 0;
    const reload = () => void (reloads += 1);
    expect(reloadForNewBuild(storage, reload, 1_000_000)).toBe(true);
    expect(reloadForNewBuild(storage, reload, 1_005_000)).toBe(false);
    expect(reloads).toBe(1);
    // A later upgrade, in the same tab, reloads it again.
    expect(reloadForNewBuild(storage, reload, 1_000_000 + 61_000)).toBe(true);
    expect(reloads).toBe(2);
  });

  test("with nowhere to remember it, it does not reload at all — the page's Reload button is there", () => {
    let reloads = 0;
    const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} };
    expect(reloadForNewBuild(blocked, () => void (reloads += 1))).toBe(false);
    expect(reloadForNewBuild(undefined, () => void (reloads += 1))).toBe(false);
    expect(reloads).toBe(0);
  });
});
