/**
 * A tab left open across an update (`commons/lib/bundle.ts`): it kept calling the new daemon with the old code, and
 * nothing told it to reload.
 */

import { describe, expect, test } from "bun:test";
import { bundleVersion, staleBundle } from "@/commons/lib/bundle";

describe("a page older than its daemon", () => {
  test("is told by the version the daemon reports — whichever way round, a rollback too", () => {
    expect(staleBundle("0.7.7", "0.7.8")).toBe(true);
    expect(staleBundle("0.7.8", "0.7.7")).toBe(true);
  });

  test("one release written two ways is one release", () => {
    expect(staleBundle("0.7.8", "0.7.8")).toBe(false);
    expect(staleBundle("v0.7.8", "0.7.8")).toBe(false);
    expect(staleBundle("0.7.8", "v0.7.8")).toBe(false);
  });

  test("what is not known is not a reason to reload: no stamp — a test, the dev server — or no answer yet", () => {
    expect(staleBundle(null, "0.7.8")).toBe(false);
    expect(staleBundle("0.7.8", undefined)).toBe(false);
    expect(staleBundle("0.7.8", "")).toBe(false);
  });

  test("outside a build there is no stamp, and reading it does not throw", () => {
    expect(bundleVersion()).toBeNull();
  });
});
