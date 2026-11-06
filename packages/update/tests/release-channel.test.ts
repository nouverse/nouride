/**
 * What the release channel's answer is read into, and how long it is believed.
 *
 * `release.test.ts` covers the decisions a person sees; this file holds the edges of the two fetches under them, each
 * one a mutant the 0.7.11 mutation sweep found nothing catching: a body that is not a list read as "no releases", an
 * entry with no tag offered as one, the cache served to a channel it was not asked of, a recovered channel still
 * labelled stale, and the checksum file — fetched during every check that finds something newer — cached by nothing.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  channelStaleness,
  checksumUrl,
  fetchChecksums,
  fetchReleases,
  forgetChannel,
  githubSource,
} from "../src/release.ts";

beforeEach(() => forgetChannel());

const MINUTE = 60_000;

function answering(...bodies: Array<{ status: number; body: unknown }>) {
  const asked: string[] = [];
  let i = 0;
  const impl = (async (url: string) => {
    asked.push(url);
    const { status, body } = bodies[Math.min(i++, bodies.length - 1)]!;
    return { ok: status === 200, status, json: async () => body };
  }) as never;
  return { impl, asked };
}

const ok = (body: unknown) => ({ status: 200, body });
const LIST = [{ tag_name: "v0.3.2", assets: [{ name: "SHA256SUMS" }] }];

describe("reading the list", () => {
  test("a body that is not a list is an error, never an empty list", async () => {
    // A string body iterates as characters, each one skipped for having no tag: "nothing newer", from a proxy's page.
    for (const body of [{ message: "Not Found" }, "<html>captive portal</html>"]) {
      forgetChannel();
      const { impl } = answering(ok(body));
      await expect(fetchReleases({ downloadBase: "b", releasesUrl: "u" }, impl)).rejects.toThrow(
        "the release channel did not return a list of releases",
      );
    }
  });

  test("an entry with no tag is not a release, and an asset with no name is not an asset", async () => {
    const { impl } = answering(
      ok([
        { tag_name: "", assets: [{ name: "x" }] },
        { assets: [{ name: "y" }] },
        { tag_name: "v0.3.2", assets: [{ name: "SHA256SUMS" }, { size: 1 }, { name: 7 }] },
      ]),
    );
    const releases = await fetchReleases({ downloadBase: "b", releasesUrl: "u" }, impl);
    expect(releases.map((r) => r.tag)).toEqual(["v0.3.2"]);
    expect(releases[0]!.assets).toEqual(["SHA256SUMS"]);
  });

  test("the publish date and the notes link are carried when given, and null when not", async () => {
    const { impl } = answering(
      ok([
        { tag_name: "v0.3.3", published_at: "2026-09-13T07:47:11Z", html_url: "https://example.invalid/v0.3.3" },
        { tag_name: "v0.3.2", published_at: 12, html_url: null },
      ]),
    );
    const [newest, older] = await fetchReleases({ downloadBase: "b", releasesUrl: "u" }, impl);
    expect(newest).toMatchObject({ publishedAt: "2026-09-13T07:47:11Z", notesUrl: "https://example.invalid/v0.3.3" });
    expect(older).toMatchObject({ publishedAt: null, notesUrl: null });
  });
});

describe("how long an answer is believed", () => {
  test("a cached answer is the answer, not just a skipped request", async () => {
    const { impl, asked } = answering(ok(LIST));
    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, impl, { now: 0 });
    const again = await fetchReleases(channel, impl, { now: 1 });
    expect(asked).toHaveLength(1);
    expect(again.map((r) => r.tag)).toEqual(["v0.3.2"]);
  });

  test("the window is five minutes, to the millisecond", async () => {
    const { impl, asked } = answering(ok(LIST));
    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, impl, { now: 0 });
    await fetchReleases(channel, impl, { now: 5 * MINUTE - 1 });
    expect(asked).toHaveLength(1);
    await fetchReleases(channel, impl, { now: 5 * MINUTE });
    expect(asked).toHaveLength(2);
  });

  test("a held failure is held for one minute, to the millisecond", async () => {
    const { impl, asked } = answering({ status: 503, body: [] });
    const channel = { downloadBase: "b", releasesUrl: "u" };
    await expect(fetchReleases(channel, impl, { now: 0 })).rejects.toThrow(/503/);
    await expect(fetchReleases(channel, impl, { now: MINUTE - 1 })).rejects.toThrow(/503/);
    expect(asked).toHaveLength(1);
    await expect(fetchReleases(channel, impl, { now: MINUTE })).rejects.toThrow(/503/);
    expect(asked).toHaveLength(2);
  });

  test("one channel's answer — or its failure — is never served for another", async () => {
    const a = { downloadBase: "b", releasesUrl: "a" };
    const b = { downloadBase: "b", releasesUrl: "b" };

    const listed = answering(ok(LIST));
    await fetchReleases(a, listed.impl, { now: 0 });
    await fetchReleases(b, listed.impl, { now: 1 });
    expect(listed.asked).toEqual(["a", "b"]);

    // B failing with A's answer cached: an error for B, not A's releases dressed as B's.
    forgetChannel();
    const flaky = answering(ok(LIST), { status: 503, body: [] });
    await fetchReleases(a, flaky.impl, { now: 0 });
    await expect(fetchReleases(b, flaky.impl, { now: 1, force: true })).rejects.toThrow(/503/);

    // A held failure for A does not stop B being asked.
    forgetChannel();
    const down = answering({ status: 503, body: [] }, ok(LIST));
    await expect(fetchReleases(a, down.impl, { now: 0 })).rejects.toThrow(/503/);
    expect((await fetchReleases(b, down.impl, { now: 1 })).map((r) => r.tag)).toEqual(["v0.3.2"]);
  });

  test("a channel that answers again is no longer labelled stale", async () => {
    const { impl } = answering(ok(LIST), { status: 403, body: [] }, ok(LIST));
    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, impl, { now: 0 });
    await fetchReleases(channel, impl, { now: 1, force: true });
    expect(channelStaleness()).toContain("403");
    await fetchReleases(channel, impl, { now: 2, force: true });
    expect(channelStaleness()).toBeNull();
  });

  test("forgetting the channel forgets its staleness too", async () => {
    const { impl } = answering(ok(LIST), { status: 403, body: [] });
    const channel = { downloadBase: "b", releasesUrl: "u" };
    await fetchReleases(channel, impl, { now: 0 });
    await fetchReleases(channel, impl, { now: 1, force: true });
    expect(channelStaleness()).not.toBeNull();
    forgetChannel();
    expect(channelStaleness()).toBeNull();
  });
});

describe("the checksum file", () => {
  function sums(text: string) {
    const asked: string[] = [];
    const impl = (async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, text: async () => text };
    }) as unknown as typeof fetch;
    return { impl, asked };
  }

  test("is fetched once inside the window, on the clock when none is given, and the cached text is returned", async () => {
    const { impl, asked } = sums("aaaa  ./nouride-linux-x64.tar.gz");
    expect(await fetchChecksums("https://x/v1/SHA256SUMS", impl)).toBe("aaaa  ./nouride-linux-x64.tar.gz");
    expect(await fetchChecksums("https://x/v1/SHA256SUMS", impl)).toBe("aaaa  ./nouride-linux-x64.tar.gz");
    expect(asked).toHaveLength(1);
  });

  test("is asked again for another URL, when forced, and from five minutes on", async () => {
    const { impl, asked } = sums("aaaa  ./nouride-linux-x64.tar.gz");
    await fetchChecksums("https://x/v1/SHA256SUMS", impl, { now: 0 });
    await fetchChecksums("https://x/v2/SHA256SUMS", impl, { now: 1 });
    expect(asked).toHaveLength(2);
    await fetchChecksums("https://x/v2/SHA256SUMS", impl, { now: 2, force: true });
    expect(asked).toHaveLength(3);
    await fetchChecksums("https://x/v2/SHA256SUMS", impl, { now: 5 * MINUTE + 1 });
    expect(asked).toHaveLength(3);
    await fetchChecksums("https://x/v2/SHA256SUMS", impl, { now: 5 * MINUTE + 2 });
    expect(asked).toHaveLength(4);
  });
});

describe("the URLs", () => {
  test("a download base given with a trailing slash does not double it", () => {
    const channel = { downloadBase: "https://get.example.invalid/", releasesUrl: "u" };
    expect(githubSource(channel).tarballUrl("v0.3.3", "nouride-linux-x64")).toBe(
      "https://get.example.invalid/v0.3.3/nouride-linux-x64.tar.gz",
    );
    expect(checksumUrl(channel, "v0.3.3", "SHA256SUMS")).toBe("https://get.example.invalid/v0.3.3/SHA256SUMS");
  });
});
