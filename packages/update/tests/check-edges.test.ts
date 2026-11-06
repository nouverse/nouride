/**
 * The edges of `checkForUpdate` that `release.test.ts` leaves open — each one a mutant the 0.7.11 mutation sweep
 * found nothing catching.
 *
 * The engine calls the check with a source and no `fetch` of its own, so the global `fetch` reading the checksum file
 * is the production path, not a default nobody takes; and a check runs on every dashboard poll, so what it caches and
 * what it does not ask for are behaviour too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkForUpdate } from "../src/index.ts";
import { forgetChannel, githubSource, type Release } from "../src/release.ts";
import type { InstallFacts } from "../src/plan.ts";

beforeEach(() => forgetChannel());

const INSTALLED: InstallFacts = {
  version: "0.3.2",
  edition: "basic",
  installDir: "/srv/nouride",
  installDirWritable: true,
  supervisor: "systemd",
  restartsOnExit: true,
  compiled: true,
  platform: "linux",
  arch: "x64",
  musl: false,
};

const FREE = ["nouride-linux-x64.tar.gz", "SHA256SUMS"];
const COVERING = "aaaa  ./nouride-linux-x64.tar.gz";

const apiRelease = (tag: string, assets: string[]) => ({
  tag_name: tag,
  published_at: "2026-09-13T07:47:11Z",
  html_url: `https://example.invalid/${tag}`,
  assets: assets.map((name) => ({ name })),
});

/** A channel and its checksum file, counting what is asked of each. */
function channel(list: unknown[], sums: string | null = COVERING) {
  const asked = { releases: 0, sums: 0 };
  const impl = (async (url: string) => {
    if (String(url).includes("SHA256SUMS")) {
      asked.sums += 1;
      return sums === null ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => sums };
    }
    asked.releases += 1;
    return { ok: true, status: 200, json: async () => list };
  }) as unknown as typeof fetch;
  return { impl, asked };
}

describe("what the check asks the channel", () => {
  test("a second check inside the window asks for neither the list nor the checksum file", async () => {
    const { impl, asked } = channel([apiRelease("v0.3.3", FREE)]);
    await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    const again = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(again.newer).toBe(true);
    expect(asked).toEqual({ releases: 1, sums: 1 });
  });

  test("being current never fetches the checksum file", async () => {
    const { impl, asked } = channel([apiRelease("v0.3.2", FREE)], "dddd  ./something-else.tar.gz");
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check.newer).toBe(false);
    expect(asked.sums).toBe(0);
  });

  test("a checksum file that cannot be fetched leaves the update offered — the install verifies it", async () => {
    const { impl } = channel([apiRelease("v0.3.3", FREE)], null);
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check.newer).toBe(true);
    expect(check.plan?.can).toBe(true);
  });

  describe("with no fetch passed, as the engine calls it", () => {
    const real = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = real;
    });

    test("the global fetch reads the checksum file, and one that does not cover this build blocks it", async () => {
      const { impl, asked } = channel([apiRelease("v0.3.3", FREE)], "dddd  ./something-else.tar.gz");
      globalThis.fetch = impl;
      const releases: Release[] = [
        { tag: "v0.3.3", publishedAt: null, notesUrl: null, assets: FREE },
      ];
      const source = { ...githubSource(), releases: async () => releases };
      const check = await checkForUpdate({ facts: INSTALLED, source });
      expect(asked.sums).toBe(1);
      expect(check.newer).toBe(false);
      expect(check.blockedReason).toContain("checksum file does not cover it");
    });
  });
});

describe("what the check says", () => {
  test("an empty channel is current, not an error", async () => {
    const { impl } = channel([]);
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check).toMatchObject({ current: "0.3.2", latest: "0.3.2", newer: false });
    expect(check.latestElsewhere).toBeUndefined();
  });

  test("nothing for this build leaves the date and the notes null, not missing", async () => {
    const { impl } = channel([apiRelease("v0.3.3", FREE)], "dddd  ./something-else.tar.gz");
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check.publishedAt).toBeNull();
    expect(check.notesUrl).toBeNull();
  });

  test("an install newer than the channel is not told about an older release elsewhere", async () => {
    // Its build is on v0.3.1; v0.3.2 is newer on the channel and still older than what runs here.
    const { impl } = channel([apiRelease("v0.3.2", ["other.txt"]), apiRelease("v0.3.1", FREE)]);
    const check = await checkForUpdate({ facts: { ...INSTALLED, version: "0.3.3" }, fetchImpl: impl });
    expect(check.newer).toBe(false);
    expect(check.latestElsewhere).toBeUndefined();
  });

  test("a tarball published without its checksum file does not make the build 'unpublished'", async () => {
    // It is published, and cannot be verified: not offered, and not told "no build for linux/x64 is published".
    const { impl } = channel([apiRelease("v0.3.3", ["nouride-linux-x64.tar.gz"]), apiRelease("v0.3.2", [])]);
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check.newer).toBe(false);
    expect(check.plan).toBeUndefined();
    expect(check.latestElsewhere).toBe("v0.3.3");
  });

  test("a channel of one release that carries no build of this edition still says so", async () => {
    const { impl } = channel([apiRelease("v0.3.3", FREE)]);
    const check = await checkForUpdate({ facts: { ...INSTALLED, edition: "pro" }, fetchImpl: impl });
    expect(check).toMatchObject({ newer: true, latest: "v0.3.3" });
    expect(check.plan?.can === false && check.plan.reason).toBe("no pro build is published on this release channel");
  });

  test("a platform is unpublished when any release carries the edition, not only when all do", async () => {
    // The newest release carries the free builds; an older one carried nothing. A Mac is told about its platform.
    const { impl } = channel([apiRelease("v0.3.3", FREE), apiRelease("v0.3.2", ["notes.txt"])]);
    const check = await checkForUpdate({ facts: { ...INSTALLED, platform: "darwin", arch: "arm64" }, fetchImpl: impl });
    expect(check.plan?.can === false && check.plan.reason).toBe("no build for darwin/arm64 is published on this release channel");
  });

  test("a signed-era release with its signature taken away is refused by the check, before any download", async () => {
    // The plan sees the release's assets; without them it would ask for the signature and fail only at install.
    const { impl } = channel([apiRelease("v0.7.4", FREE)]);
    const check = await checkForUpdate({ facts: INSTALLED, fetchImpl: impl });
    expect(check.newer).toBe(true);
    expect(check.plan?.can === false && check.plan.reason).toContain("lists no signature for SHA256SUMS");
  });
});
