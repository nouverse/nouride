/**
 * Which releases an install is offered (0.8.18, PLAN §3.3, REVIEW A1 and B1): every page of the channel read, the
 * releases ordered by version rather than by date, and the track the install follows. `latest` takes the newest of all;
 * `lts` stays on a long-term line (1.0 the first), and each says what the other would offer.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { checkForUpdate } from "../src/index.ts";
import { fetchReleases, forgetChannel, newestFirst, type Release } from "../src/release.ts";
import { ltsCeiling, onTrack } from "../src/track.ts";
import type { InstallFacts } from "../src/plan.ts";

beforeEach(() => forgetChannel());

const ASSETS = ["nouride-linux-x64.tar.gz", "CHECKSUMS", "SHA256SUMS"];
const apiRelease = (tag: string, publishedAt = "2026-11-04T00:00:00Z") => ({
  tag_name: tag,
  published_at: publishedAt,
  html_url: `https://example.invalid/${tag}`,
  assets: ASSETS.map((name) => ({ name })),
});
const release = (tag: string): Release => ({ tag, publishedAt: null, notesUrl: null, assets: ASSETS });
const tags = (releases: Release[]) => releases.map((r) => r.tag);

/** A channel serving pages by the `page` query; the first page has none. Records what was asked. */
function paged(pages: unknown[][], failPage?: number) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    if (page === failPage) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] };
  }) as never;
  return { impl, asked };
}

describe("every page of the channel", () => {
  test("pages are read until one comes back shorter than the size asked for", async () => {
    const { impl, asked } = paged([[apiRelease("v1.0.2"), apiRelease("v1.0.1")], [apiRelease("v1.0.0"), apiRelease("v0.8.24")], [apiRelease("v0.7.29")]]);
    const releases = await fetchReleases({ downloadBase: "b", releasesUrl: "u?per_page=2" }, impl);
    expect(tags(releases)).toEqual(["v1.0.2", "v1.0.1", "v1.0.0", "v0.8.24", "v0.7.29"]);
    expect(asked).toEqual(["u?per_page=2", "u?per_page=2&page=2", "u?per_page=2&page=3"]);
  });

  test("a bridge on the second page is found: an updater reading one page missed it (REVIEW A1)", async () => {
    const { impl } = paged([[apiRelease("v1.0.9"), apiRelease("v1.0.8")], [apiRelease("v0.7.29")]]);
    const releases = await fetchReleases({ downloadBase: "b", releasesUrl: "u?per_page=2" }, impl);
    expect(tags(releases)).toContain("v0.7.29");
  });

  test("a later page failing fails the read, as the first does: a short list can hide the release that matters", async () => {
    const { impl } = paged([[apiRelease("v1.0.2"), apiRelease("v1.0.1")], []], 2);
    await expect(fetchReleases({ downloadBase: "b", releasesUrl: "u?per_page=2" }, impl)).rejects.toThrow("the release channel answered 403");
  });

  test("a channel that ignores the page and answers the first again is read once more, not ten times", async () => {
    const same = [apiRelease("v1.0.2"), apiRelease("v1.0.1")];
    const { impl, asked } = paged([same, same, same, same]);
    const releases = await fetchReleases({ downloadBase: "b", releasesUrl: "u?per_page=2" }, impl);
    expect(tags(releases)).toEqual(["v1.0.2", "v1.0.1"]);
    expect(asked).toHaveLength(2);
  });

  test("the mirror is asked a hundred a page, so today it is still one request", async () => {
    const { DEFAULT_CHANNEL } = await import("../src/release.ts");
    expect(DEFAULT_CHANNEL.releasesUrl).toEndWith("?per_page=100");
  });
});

describe("ordered by version, not by date", () => {
  test("a patch to an older line published after a newer release is not the newest (REVIEW B1)", () => {
    expect(tags(newestFirst([release("v1.0.8"), release("v1.1.1"), release("v1.1.0"), release("v1.0.7")]))).toEqual(["v1.1.1", "v1.1.0", "v1.0.8", "v1.0.7"]);
  });

  test("a tag that is not a version goes last, in the order it came", () => {
    expect(tags(newestFirst([release("nightly"), release("v1.0.1"), release("rehearsal"), release("v1.0.2")]))).toEqual(["v1.0.2", "v1.0.1", "nightly", "rehearsal"]);
  });
});

describe("the tracks", () => {
  test("lts moves 0.8 to the first long-term line, keeps 1.0 on 1.0, and a line past every long-term one to itself", () => {
    expect(ltsCeiling("0.8.18")).toEqual([1, 0]);
    expect(ltsCeiling("1.0.3")).toEqual([1, 0]);
    expect(ltsCeiling("1.1.2")).toEqual([1, 1]);
    expect(ltsCeiling("1.0.3", ["1.0", "1.3"])).toEqual([1, 0]);
    expect(ltsCeiling("1.1.0", ["1.0", "1.3"])).toEqual([1, 3]);
    expect(ltsCeiling("not a version")).toBeNull();
  });

  test("lts keeps every line up to its ceiling, so a stepping stone on the install's own line is still offered", () => {
    const all = [release("v1.1.0"), release("v1.0.2"), release("v1.0.1"), release("v0.8.24"), release("v0.8.19"), release("nightly")];
    expect(tags(onTrack(all, "0.8.18", "lts"))).toEqual(["v1.0.2", "v1.0.1", "v0.8.24", "v0.8.19"]);
    expect(tags(onTrack(all, "1.0.1", "lts"))).toEqual(["v1.0.2", "v1.0.1", "v0.8.24", "v0.8.19"]);
    expect(tags(onTrack(all, "0.8.18", "latest"))).toEqual(tags(all));
  });
});

describe("the check, on each track", () => {
  const INSTALLED: InstallFacts = {
    version: "1.0.5",
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
  // As the API lists them, newest by date first: 1.0.7 was published after 1.1.0.
  const LISTED = [apiRelease("v1.0.7", "2026-12-03T00:00:00Z"), apiRelease("v1.1.0", "2026-12-01T00:00:00Z"), apiRelease("v1.0.6", "2026-11-20T00:00:00Z")];
  const SUMS = "aaaa  ./nouride-linux-x64.tar.gz";
  const channel = (() =>
    (async (url: string) =>
      /SUMS$/.test(String(url)) ? { ok: true, status: 200, text: async () => SUMS } : { ok: true, status: 200, json: async () => LISTED })) as unknown as () => typeof fetch;
  const check = (version: string, track?: "lts" | "latest") =>
    checkForUpdate({ facts: { ...INSTALLED, version }, channel: { downloadBase: "b", releasesUrl: "u" }, fetchImpl: channel(), ...(track ? { track } : {}) });

  test("latest takes the newest version, not the newest date, and says the long-term line's newest is there", async () => {
    const result = await check("1.0.5", "latest");
    expect(result.track).toBe("latest");
    expect(result.latest).toBe("v1.1.0");
    expect(result.otherTrack).toEqual({ track: "lts", tag: "v1.0.7" });
  });

  test("lts on 1.0 takes 1.0's newest and says 1.1 is there", async () => {
    const result = await check("1.0.5", "lts");
    expect(result.track).toBe("lts");
    expect(result.latest).toBe("v1.0.7");
    expect(result.newer).toBe(true);
    expect(result.otherTrack).toEqual({ track: "latest", tag: "v1.1.0" });
  });

  test("with no track given it is latest, as every install was before 0.8.18", async () => {
    const result = await check("1.0.5");
    expect(result.track).toBe("latest");
    expect(result.latest).toBe("v1.1.0");
  });

  test("nothing about the other track when both offer the same", async () => {
    const result = await check("1.1.0", "lts");
    expect(result.newer).toBe(false);
    expect(result.otherTrack).toBeUndefined();
  });
});

describe("a source that chooses for the install", () => {
  test("is asked with the track, as the appliance's asks Nouverse within it", async () => {
    const asked: unknown[] = [];
    const source = {
      name: "appliance",
      releases: async (options?: unknown) => {
        asked.push(options);
        return [];
      },
      tarballUrl: () => "",
      checksumUrl: () => "",
      staleness: () => null,
    };
    const facts = { version: "1.0.5", edition: "pro", installDir: "/srv/nouride", installDirWritable: true, supervisor: "systemd", restartsOnExit: true, compiled: true, platform: "linux", arch: "x64", musl: false } as InstallFacts;
    await checkForUpdate({ facts, source, track: "lts" });
    await checkForUpdate({ facts, source });
    expect(asked).toEqual([{ force: false, track: "lts" }, { force: false, track: "latest" }]);
  });
});

