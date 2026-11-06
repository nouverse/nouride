/**
 * Version comparison, which decides whether a daemon offers to replace itself.
 *
 * The cases worth writing down are the ones where a wrong answer *acts*: an unparseable
 * tag must not read as newer, and a pre-release must not be offered over the release it
 * came from.
 */

import { describe, expect, test } from "bun:test";
import { compareVersions, isNewer, parseVersion } from "../src/version.ts";

describe("parsing", () => {
  test("takes a bare version and a v-prefixed tag alike", () => {
    expect(parseVersion("0.3.2")).toEqual({ major: 0, minor: 3, patch: 2, prerelease: "" });
    expect(parseVersion("v0.3.2")).toEqual({ major: 0, minor: 3, patch: 2, prerelease: "" });
  });

  test("keeps a pre-release suffix", () => {
    expect(parseVersion("1.0.0-rc.2")?.prerelease).toBe("rc.2");
  });

  test("refuses what it cannot read rather than guessing zero", () => {
    // `0.0.0` would make every install look out of date against a tag nobody understood.
    for (const junk of ["latest", "", "1.2", "1.2.3.4", "v", "release-7"]) {
      expect(parseVersion(junk)).toBeNull();
    }
  });
});

describe("ordering", () => {
  test("compares by major, then minor, then patch", () => {
    const cmp = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("1.0.0", "2.0.0")).toBe(-1);
    expect(cmp("1.9.0", "1.10.0")).toBe(-1); // not string order
    expect(cmp("0.3.2", "0.3.2")).toBe(0);
    expect(cmp("0.4.0", "0.3.9")).toBe(1);
  });

  test("a release outranks a pre-release of the same numbers", () => {
    const cmp = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(cmp("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });
});

describe("isNewer", () => {
  test("says yes only for something actually newer", () => {
    expect(isNewer("0.3.2", "v0.3.3")).toBe(true);
    expect(isNewer("0.3.2", "v0.3.2")).toBe(false);
    expect(isNewer("0.3.2", "v0.3.1")).toBe(false);
  });

  test("an unreadable version on either side is not an update", () => {
    /**
     * The direction matters. A channel that answers with something unparseable — an
     * error page, a renamed tag scheme — must not be read as "newer", because the next
     * thing that happens is a daemon asking to replace itself.
     */
    expect(isNewer("0.3.2", "not-a-version")).toBe(false);
    expect(isNewer("dev", "v0.9.9")).toBe(false);
  });

  test("a pre-release is not offered over the release it came from", () => {
    expect(isNewer("1.0.0", "v1.0.0-rc.1")).toBe(false);
    expect(isNewer("1.0.0-rc.1", "v1.0.0")).toBe(true);
  });
});
