/**
 * Which release is the newest one *for this build*.
 *
 * This is the rule that stops a community install being offered something it cannot have. The
 * public channel receives the free edition's tarballs and nothing else, so a release can exist
 * without existing for a given edition — a Pro-only version, or a run where the public job
 * did not publish — and reading the newest *tag* would tell that install it is out of date and
 * then fail it at the download with a 404.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { checkForUpdate } from "../src/index.ts";
import { channelStaleness, fetchReleases, forgetChannel, newestCarrying, type Release } from "../src/release.ts";
import type { InstallFacts } from "../src/plan.ts";

/**
 * The channel cache is module-level, which is right for a daemon and wrong for a test file:
 * one case's answer would otherwise be served to the next.
 */
beforeEach(() => forgetChannel());

const FREE_ASSETS = ["nouride-linux-x64.tar.gz", "nouride-linux-arm64.tar.gz", "SHA256SUMS"];

function release(tag: string, assets: string[]): Release {
  return { tag, publishedAt: "2026-09-13T07:47:11Z", notesUrl: `https://example.invalid/${tag}`, assets };
}

/**
 * A `fetch` answering the releases API, and the checksum file the check now also reads.
 *
 * `checksums` defaults to covering every free-edition tarball. A test that wants the case where
 * a release publishes a build its checksum file does not cover passes a shorter one.
 */
function channelServing(body: unknown, status = 200, checksums = DEFAULT_SUMS): typeof fetch {
  return (async (url: string) =>
    String(url).includes("SHA256SUMS")
      ? { ok: true, status: 200, text: async () => checksums }
      : { ok: status === 200, status, json: async () => body }) as unknown as typeof fetch;
}

const DEFAULT_SUMS = [
  "aaaa  ./nouride-linux-x64.tar.gz",
  "bbbb  ./nouride-linux-arm64.tar.gz",
  "cccc  ./nouride-pro-linux-arm64.tar.gz",
].join("\n");

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

const apiRelease = (tag: string, assets: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: "2026-09-13T07:47:11Z",
  html_url: `https://example.invalid/${tag}`,
  assets: assets.map((name) => ({ name })),
  ...extra,
});

describe("reading the release list", () => {
  test("keeps published releases and drops drafts and pre-releases", async () => {
    const releases = await fetchReleases(
      { downloadBase: "b", releasesUrl: "u" },
      channelServing([
        apiRelease("v0.5.0", FREE_ASSETS, { draft: true }),
        apiRelease("v0.4.0", FREE_ASSETS, { prerelease: true }),
        apiRelease("v0.3.2", FREE_ASSETS),
      ]) as never,
    );
    expect(releases.map((r) => r.tag)).toEqual(["v0.3.2"]);
    expect(releases[0]!.assets).toContain("SHA256SUMS");
  });

  test("a channel that answers with a status is an error, not an empty list", async () => {
    /**
     * The direction matters: "the channel answered 403" and "there is nothing newer" are
     * answers a person acts on differently, and collapsing them is how a rate-limited check
     * starts reporting that everything is up to date.
     */
    await expect(
      fetchReleases({ downloadBase: "b", releasesUrl: "u" }, channelServing([], 403) as never),
    ).rejects.toThrow(/403/);
  });
});

describe("picking the newest release that carries this edition", () => {
  const list = [
    release("v0.4.0", ["nouride-pro-notes.txt"]),
    release("v0.3.3", ["nouride-linux-x64.tar.gz"]), // tarball, but no checksums
    release("v0.3.2", FREE_ASSETS),
  ];

  test("skips releases that do not carry the tarball", () => {
    expect(newestCarrying(list, "nouride-linux-x64", () => "SHA256SUMS")?.tag).toBe("v0.3.2");
  });

  test("a release with the tarball and no checksums does not count", () => {
    /**
     * Verification happens against that file. A release with one and not the other is one that
     * would fail *after* the download rather than before it, which is the expensive order.
     */
    expect(newestCarrying([list[1]!], "nouride-linux-x64", () => "SHA256SUMS")).toBeNull();
  });

  test("nothing carrying it at all is null, not the newest tag", () => {
    expect(newestCarrying(list, "nouride-pro-linux-arm64", () => "SHA256SUMS-pro")).toBeNull();
  });
});

describe("what a community install is told", () => {
  test("a release built only for Pro is not offered to it", async () => {
    /**
     * The case this whole file exists for. v0.4.0 is published; it has no free-edition build.
     * A community install must not be told to update — and must not be left wondering either,
     * so the newer tag is reported separately as something that exists elsewhere.
     */
    const check = await checkForUpdate({
      facts: INSTALLED,
      fetchImpl: channelServing([apiRelease("v0.4.0", ["other.txt"]), apiRelease("v0.3.2", FREE_ASSETS)]),
    });

    expect(check.newer).toBe(false);
    expect(check.latest).toBe("v0.3.2");
    expect(check.plan).toBeUndefined();
    expect(check.latestElsewhere).toBe("v0.4.0");
  });

  test("a release that does carry its build is offered", async () => {
    const check = await checkForUpdate({
      facts: INSTALLED,
      fetchImpl: channelServing([apiRelease("v0.3.3", FREE_ASSETS), apiRelease("v0.3.2", FREE_ASSETS)]),
    });
    expect(check.newer).toBe(true);
    expect(check.latest).toBe("v0.3.3");
    expect(check.plan?.can).toBe(true);
    expect(check.latestElsewhere).toBeUndefined();
  });

  test("being current is not reported as an update available elsewhere", async () => {
    // `latestElsewhere` is about a version this install cannot have, not about every tag.
    const check = await checkForUpdate({
      facts: INSTALLED,
      fetchImpl: channelServing([apiRelease("v0.3.2", FREE_ASSETS)]),
    });
    expect(check.newer).toBe(false);
    expect(check.latestElsewhere).toBeUndefined();
  });

  test("a Pro install off a box is told the release exists, and where its build is — not that it is up to date", async () => {
    /**
     * The public mirror never carries a Pro tarball, so a Pro server on it saw `newer: false` and "up to date" while it
     * missed fixes, and the one command it could be offered was `curl … | sudo sh -s -- --variant pro`, which the
     * installer refuses.
     */
    const check = await checkForUpdate({
      facts: { ...INSTALLED, edition: "pro", arch: "arm64" },
      fetchImpl: channelServing([apiRelease("v0.3.3", FREE_ASSETS), apiRelease("v0.3.2", FREE_ASSETS)]),
    });
    expect(check).toMatchObject({ newer: true, latest: "v0.3.3" });
    expect(check.latestElsewhere).toBeUndefined();
    const plan = check.plan!;
    expect(plan.can).toBe(false);
    if (plan.can) throw new Error("unreachable");
    expect(plan.reason).toBe("no pro build is published on this release channel");
    const instead = plan.instead.join("\n");
    expect(instead).toContain("nouride-pro-linux-arm64.tar.gz, SHA256SUMS-pro and SHA256SUMS-pro.sig from the v0.3.3 release of the internal repository");
    expect(instead).toContain("sudo sh install.sh --tarball nouride-pro-linux-arm64.tar.gz --variant pro");
    expect(instead).not.toContain("curl");
  });

  test("a macOS install is told no build for it is published, and how to build one", async () => {
    // Releases carry the four Linux builds and no other: "up to date" there meant "never", every time.
    const check = await checkForUpdate({
      facts: { ...INSTALLED, platform: "darwin", arch: "arm64" },
      fetchImpl: channelServing([apiRelease("v0.3.3", FREE_ASSETS), apiRelease("v0.3.2", FREE_ASSETS)]),
    });
    expect(check).toMatchObject({ newer: true, latest: "v0.3.3" });
    const plan = check.plan!;
    if (plan.can) throw new Error("a build nobody published was planned");
    expect(plan.reason).toBe("no build for darwin/arm64 is published on this release channel");
    expect(plan.instead).toEqual([
      "build it from source: bun run build:binary --target darwin-arm64",
      "then: sh scripts/install.sh --tarball dist/nouride-darwin-arm64.tar.gz",
    ]);
  });

  test("a build the channel carries in an older release is not 'unpublished': it is up to date", async () => {
    // The newest release built only for Pro, an older one for this build: the old answer stands, with the tag named.
    const check = await checkForUpdate({
      facts: INSTALLED,
      fetchImpl: channelServing([apiRelease("v0.3.3", ["nouride-pro-linux-x64.tar.gz", "SHA256SUMS-pro"]), apiRelease("v0.3.2", FREE_ASSETS)]),
    });
    expect(check.newer).toBe(false);
    expect(check.latestElsewhere).toBe("v0.3.3");
    expect(check.plan).toBeUndefined();
  });

  test("being current on a channel that never carries the build is still being current", async () => {
    const check = await checkForUpdate({
      facts: { ...INSTALLED, edition: "pro", version: "0.3.3" },
      fetchImpl: channelServing([apiRelease("v0.3.3", FREE_ASSETS)]),
    });
    expect(check.newer).toBe(false);
    expect(check.plan).toBeUndefined();
  });

  test("a release whose checksum file does not cover this build is not offered", async () => {
    /**
     * Found by running the flow on a Mac: the published `SHA256SUMS` lists the four Linux
     * builds and not the two macOS ones, so the install matched on assets, downloaded 55 MB,
     * and met "no checksum for nouride-darwin-arm64.tar.gz" at the verify step. The verify is
     * right to refuse — an unverified binary is not one to run — so the check has to know it
     * too, before anything is moved.
     */
    const check = await checkForUpdate({
      facts: { ...INSTALLED, platform: "darwin", arch: "arm64" },
      fetchImpl: channelServing(
        [apiRelease("v0.3.3", [...FREE_ASSETS, "nouride-darwin-arm64.tar.gz"]), apiRelease("v0.3.2", FREE_ASSETS)],
        200,
        DEFAULT_SUMS, // no darwin line
      ),
    });

    expect(check.newer).toBe(false);
    expect(check.latestElsewhere).toBe("v0.3.3");
    expect(check.blockedReason).toContain("checksum file does not cover it");
  });

  test("and is offered once the checksum file does cover it", async () => {
    const check = await checkForUpdate({
      facts: { ...INSTALLED, platform: "darwin", arch: "arm64" },
      fetchImpl: channelServing(
        [apiRelease("v0.3.3", [...FREE_ASSETS, "nouride-darwin-arm64.tar.gz"])],
        200,
        `${DEFAULT_SUMS}\ndddd  ./nouride-darwin-arm64.tar.gz`,
      ),
    });
    expect(check.newer).toBe(true);
    expect(check.latest).toBe("v0.3.3");
  });

  test("a platform with no published tarball is matched on the tag, because no release will carry one", async () => {
    /**
     * Asset matching would report "up to date" for ever, so the tag is the honest answer — and the
     * plan refuses the update anyway with what does work.
     */
    const check = await checkForUpdate({
      facts: { ...INSTALLED, platform: "win32" },
      fetchImpl: channelServing([apiRelease("v0.3.3", FREE_ASSETS)]),
    });
    expect(check.newer).toBe(true);
    expect(check.latest).toBe("v0.3.3");
    expect(check.plan?.can).toBe(false);
  });
});

describe("not asking the channel more than it can answer", () => {
  /**
   * The failure this prevents, measured on a Raspberry Pi: the dashboard polls `GET /update`
   * once a second while a download runs, each call asked GitHub, a 70-second download made 70
   * requests, and the unauthenticated limit of 60 an hour ran out. Every check after it — the
   * one the install does included — answered 403, so a finished download refused to install.
   */
  test("a second check inside the window does not reach the channel", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [apiRelease("v0.3.2", FREE_ASSETS)] };
    }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, counting as never);
    await fetchReleases(channel, counting as never);
    await fetchReleases(channel, counting as never);
    expect(calls).toBe(1);
  });

  test("and the window does expire", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [apiRelease("v0.3.2", FREE_ASSETS)] };
    }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    const start = 1_000_000;
    await fetchReleases(channel, counting as never, { now: start });
    await fetchReleases(channel, counting as never, { now: start + 4 * 60_000 });
    expect(calls).toBe(1);
    await fetchReleases(channel, counting as never, { now: start + 6 * 60_000 });
    expect(calls).toBe(2);
  });

  test("Check again means it", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [apiRelease("v0.3.2", FREE_ASSETS)] };
    }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, counting as never);
    await fetchReleases(channel, counting as never, { force: true });
    expect(calls).toBe(2);
  });

  test("a rate limit says so, rather than leaving somebody looking for a permission problem", async () => {
    const limited = (async () => ({ ok: false, status: 403, json: async () => [] })) as unknown as typeof fetch;
    await expect(fetchReleases({ downloadBase: "b", releasesUrl: "u" }, limited as never)).rejects.toThrow(
      /hourly rate limit/,
    );
  });
});

describe("a channel that stops answering", () => {
  test("the last answer is served, and labelled as old", async () => {
    /**
     * An hour of rate limiting is an hour with nothing to show otherwise. Releases do not
     * un-publish, so the previous answer is still the best information there is — it simply
     * must not be presented as current.
     */
    let fail = false;
    const flaky = (async () =>
      fail
        ? { ok: false, status: 403, json: async () => [] }
        : { ok: true, status: 200, json: async () => [apiRelease("v0.3.3", FREE_ASSETS)] }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    const first = await fetchReleases(channel, flaky as never);
    expect(first.map((r) => r.tag)).toEqual(["v0.3.3"]);
    expect(channelStaleness()).toBeNull();

    fail = true;
    const second = await fetchReleases(channel, flaky as never, { force: true });
    expect(second.map((r) => r.tag)).toEqual(["v0.3.3"]);
    expect(channelStaleness()).toContain("hourly rate limit");
  });

  test("with nothing cached at all it still throws", () => {
    // "Unknown" has to stay distinguishable from "up to date"; a silent empty list is how a
    // rate-limited check starts reporting that everything is current.
    const limited = (async () => ({ ok: false, status: 403, json: async () => [] })) as unknown as typeof fetch;
    return expect(fetchReleases({ downloadBase: "b", releasesUrl: "u" }, limited as never)).rejects.toThrow(/403/);
  });
});

describe("a channel that is down and was never up", () => {
  test("the failure is held rather than re-asked on every request", async () => {
    /**
     * The shape that caused the outage, in the recovery path: with nothing cached, every
     * request tried again — and the page polls once a second while a download runs. A
     * rate-limited daemon would spend its recovery hour hammering the thing that limited it.
     */
    let calls = 0;
    const limited = (async () => {
      calls += 1;
      return { ok: false, status: 403, json: async () => [] };
    }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    const start = 2_000_000;
    for (const at of [start, start + 1_000, start + 2_000, start + 30_000]) {
      await expect(fetchReleases(channel, limited as never, { now: at })).rejects.toThrow(/403/);
    }
    expect(calls).toBe(1);

    // And it does try again once the minute is up.
    await expect(fetchReleases(channel, limited as never, { now: start + 61_000 })).rejects.toThrow(/403/);
    expect(calls).toBe(2);
  });

  test("Check again still reaches the channel", async () => {
    let calls = 0;
    const limited = (async () => {
      calls += 1;
      return { ok: false, status: 403, json: async () => [] };
    }) as unknown as typeof fetch;

    const channel = { downloadBase: "b", releasesUrl: "u" };
    await expect(fetchReleases(channel, limited as never)).rejects.toThrow();
    await expect(fetchReleases(channel, limited as never, { force: true })).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

/**
 * A source supplied from outside — the appliance's, which asks the Nouverse service and downloads
 * from short-lived storage URLs. It answers *where*; every rule about *whether* stays here.
 */
describe("a release source other than GitHub", () => {
  const DEVICE: InstallFacts = { ...INSTALLED, edition: "pro", arch: "arm64" };
  const DEVICE_ASSETS = ["nouride-pro-linux-arm64.tar.gz", "SHA256SUMS-pro"];

  function sourceServing(releases: Release[], stale: string | null = null) {
    const asked: string[] = [];
    return {
      asked,
      source: {
        name: "appliance",
        releases: async () => {
          asked.push("releases");
          return releases;
        },
        tarballUrl: (tag: string, artifact: string) => `https://r2.invalid/${tag}/${artifact}.tar.gz?sig=1`,
        checksumUrl: (tag: string, checksums: string) => `https://r2.invalid/${tag}/${checksums}?sig=1`,
        signatureUrl: (tag: string, checksums: string) => `https://r2.invalid/${tag}/${checksums}.sig?sig=1`,
        staleness: () => stale,
      },
    };
  }
  const sums = (text: string) => (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch;

  test("is asked instead of GitHub, and its URLs are the plan's", async () => {
    const { source, asked } = sourceServing([release("v0.3.3", DEVICE_ASSETS)]);
    const check = await checkForUpdate({ facts: DEVICE, source, fetchImpl: sums("cccc  ./nouride-pro-linux-arm64.tar.gz") });

    expect(asked).toEqual(["releases"]);
    expect(check).toMatchObject({ newer: true, latest: "v0.3.3" });
    expect(check.plan).toMatchObject({
      can: true,
      tarballUrl: "https://r2.invalid/v0.3.3/nouride-pro-linux-arm64.tar.gz?sig=1",
      checksumUrl: "https://r2.invalid/v0.3.3/SHA256SUMS-pro?sig=1",
    });
  });

  test("cannot offer another edition's build", async () => {
    const { source } = sourceServing([release("v0.3.3", ["nouride-router-linux-arm64.tar.gz", "SHA256SUMS-router"])]);
    const check = await checkForUpdate({ facts: DEVICE, source, fetchImpl: sums("") });
    expect(check.newer).toBe(false);
    expect(check.plan).toBeUndefined();
  });

  test("cannot offer a build its checksum file does not cover", async () => {
    const { source } = sourceServing([release("v0.3.3", DEVICE_ASSETS)]);
    const check = await checkForUpdate({ facts: DEVICE, source, fetchImpl: sums("dddd  ./something-else.tar.gz") });
    expect(check.newer).toBe(false);
    expect(check.blockedReason).toContain("checksum file does not cover it");
  });

  test("reports its own staleness", async () => {
    const { source } = sourceServing([release("v0.3.2", DEVICE_ASSETS)], "the Nouverse service answered 503");
    const check = await checkForUpdate({ facts: DEVICE, source, fetchImpl: sums("") });
    expect(check.stale).toBe("the Nouverse service answered 503");
  });

  test("passes on what it says that is not an outage — a licence whose updates ended — apart from staleness", async () => {
    const { source } = sourceServing([]);
    const ended = { ...source, notice: () => "this licence's updates ended on 2027-10-27" };
    const check = await checkForUpdate({ facts: DEVICE, source: ended, fetchImpl: sums("") });
    expect(check.notice).toBe("this licence's updates ended on 2027-10-27");
    expect(check.stale).toBeUndefined();
    // A source with nothing to say, or none of the method, adds nothing.
    expect((await checkForUpdate({ facts: DEVICE, source, fetchImpl: sums("") })).notice).toBeUndefined();
  });
});
