/**
 * The upgrade floor: `# nouride-min-version: <version>` in a release's checksum files, and what each updater does with
 * it.
 *
 * 0.8.0 upgrades only from the last 0.7.x. An install's own updater decides which release it takes, so from 0.7.11 the
 * check offers the stepping stone — the newest release whose floor this version meets — instead of a release it may not
 * take, and the install refuses one whose signed checksum file says it needs a newer version first. The updaters
 * already in the field know no floor, so the line must not change what they read: 0.7.10's parser, copied below as it
 * shipped, is run on a file that carries it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate } from "../src/index.ts";
import { checksumName } from "../src/edition.ts";
import { meetsFloor, releaseFloor } from "../src/floor.ts";
import { checksumFor, hasChecksumFor, installStaged } from "../src/install.ts";
import { forgetChannel, newestCarrying } from "../src/release.ts";
import type { InstallFacts } from "../src/plan.ts";

beforeEach(() => forgetChannel());

const SUMS = "aaaa  ./nouride-linux-x64.tar.gz\nbbbb  ./nouride-linux-arm64.tar.gz\n";
const withFloor = (floor: string, sums = SUMS) => `# nouride-min-version: ${floor}\n${sums}`;

/**
 * `checksumFor` and `hasChecksumFor` exactly as v0.7.10 shipped them (`packages/update/src/install.ts` at the tag) —
 * the parser every install from 0.6.0 to 0.7.10 runs, the same lines in each. Frozen here on purpose: it is the code in
 * the field, not the code in this tree.
 */
function checksumFor0710(text: string, artifact: string): string {
  const wanted = `${artifact}.tar.gz`;
  for (const line of text.split("\n")) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (!hash || rest.length === 0) continue;
    const name = rest.join(" ").replace(/^\.\//, "");
    if (name === wanted) return hash;
  }
  throw new Error(`no checksum for ${wanted} in the release's checksum file`);
}
function hasChecksumFor0710(text: string, artifact: string): boolean {
  try {
    return checksumFor0710(text, artifact).length > 0;
  } catch {
    return false;
  }
}

describe("the floor line", () => {
  test("is read from anywhere in the file, and its absence is no floor", () => {
    expect(releaseFloor(withFloor("0.7.14"))).toBe("0.7.14");
    expect(releaseFloor(`${SUMS}# nouride-min-version: 0.7.14\r\n`)).toBe("0.7.14");
    expect(releaseFloor(SUMS)).toBeNull();
    expect(releaseFloor("# some other comment\n" + SUMS)).toBeNull();
  });

  test("is met at and above it; no floor by everyone; one this cannot read by no one", () => {
    expect(meetsFloor("0.7.14", "0.7.14")).toBe(true);
    expect(meetsFloor("0.7.15", "0.7.14")).toBe(true);
    expect(meetsFloor("0.7.11", "0.7.14")).toBe(false);
    expect(meetsFloor("0.7.14-rc.1", "0.7.14")).toBe(false);
    expect(meetsFloor("0.6.7", null)).toBe(true);
    expect(meetsFloor("9.9.9", "soon")).toBe(false);
  });

  test("is invisible to 0.7.10's parser, and to this one: the tarballs are found, the line is never a tarball", () => {
    const sums = withFloor("0.7.14");
    for (const [find, has] of [[checksumFor0710, hasChecksumFor0710], [checksumFor, hasChecksumFor]] as const) {
      expect(find(sums, "nouride-linux-x64")).toBe("aaaa");
      expect(find(sums, "nouride-linux-arm64")).toBe("bbbb");
      expect(has(sums, "nouride-min-version:")).toBe(false);
      expect(has(sums, "0.7.14")).toBe(false);
    }
  });
});

const FACTS: InstallFacts = {
  version: "0.7.11",
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
const FREE = ["nouride-linux-x64.tar.gz", "nouride-linux-arm64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"];
/** A release from 0.8.0 on: the same tarballs, and its checksum file under the new name (`CHECKSUMS_RENAMED_IN`). */
const FREE_08 = ["nouride-linux-x64.tar.gz", "nouride-linux-arm64.tar.gz", "CHECKSUMS", "CHECKSUMS.sig"];
const assetsOf = (tag: string) => (/^v0\.7\./.test(tag) ? FREE : FREE_08);

/** A channel: its release list, and each release's checksum file by tag. */
function channel(sums: Record<string, string>, assets: Record<string, string[]> = {}): typeof fetch {
  const list = Object.keys(sums).map((tag) => ({
    tag_name: tag,
    published_at: "2026-10-17T00:00:00Z",
    html_url: `https://example.invalid/${tag}`,
    assets: (assets[tag] ?? assetsOf(tag)).map((name) => ({ name })),
  }));
  return (async (url: string) => {
    const tag = /\/(v[\d.]+)\/(?:SHA256SUMS|CHECKSUMS)/.exec(String(url))?.[1];
    if (tag) return { ok: true, status: 200, text: async () => sums[tag] ?? "" };
    return { ok: true, status: 200, json: async () => list };
  }) as unknown as typeof fetch;
}

describe("the check, when the newest release has a floor above this version", () => {
  const RELEASES = { "v0.8.0": withFloor("0.7.14"), "v0.7.14": SUMS, "v0.7.13": SUMS };

  test("offers the stepping stone, says why, and --start would take the stone and never the target", async () => {
    const check = await checkForUpdate({ facts: FACTS, fetchImpl: channel(RELEASES) });
    expect(check.newer).toBe(true);
    expect(check.latest).toBe("v0.7.14");
    expect(check.floor).toEqual({ release: "v0.8.0", needs: "0.7.14", message: "update to 0.7.14 first; 0.8.0 needs it" });
    // What `nouride update --start` and the dashboard's Download act on: the plan, to the stone.
    expect(check.plan?.to).toBe("v0.7.14");
    expect(check.plan?.can && check.plan.tarballUrl).toContain("/v0.7.14/");
    expect(check.latestElsewhere).toBe("v0.8.0");
    expect(check.blockedReason).toBe("it upgrades only from 0.7.14 or later, which this install has to run first");
  });

  test("on the floor's own version, offers the release itself", async () => {
    const check = await checkForUpdate({ facts: { ...FACTS, version: "0.7.14" }, fetchImpl: channel(RELEASES) });
    expect(check.latest).toBe("v0.8.0");
    expect(check.floor).toBeUndefined();
  });

  test("passes over a stone whose own floor this version does not meet either", async () => {
    const sums = { "v0.8.0": withFloor("0.7.14"), "v0.7.14": withFloor("0.7.12"), "v0.7.13": SUMS };
    const check = await checkForUpdate({ facts: FACTS, fetchImpl: channel(sums) });
    expect(check.latest).toBe("v0.7.13");
    expect(check.floor?.message).toBe("update to 0.7.13 first; 0.8.0 needs 0.7.14 or later");
  });

  test("with no stone on the channel, offers nothing and does not call it up to date", async () => {
    const check = await checkForUpdate({ facts: FACTS, fetchImpl: channel({ "v0.8.1": withFloor("0.7.14"), "v0.8.0": withFloor("0.7.14") }) });
    expect(check.newer).toBe(false);
    expect(check.plan).toBeUndefined();
    expect(check.floor?.release).toBe("v0.8.1");
    expect(check.floor?.message).toStartWith("update to 0.7.14 first; 0.8.1 needs it, and no release this install can take now reaches it");
  });

  test("an off-box Pro server, which the channel has no build for, is pointed at the stone", async () => {
    const check = await checkForUpdate({ facts: { ...FACTS, edition: "pro" }, fetchImpl: channel(RELEASES) });
    expect(check.latest).toBe("v0.7.14");
    expect(check.plan?.can).toBe(false);
    expect(!check.plan?.can && check.plan?.instead.join("\n")).toContain("from the v0.7.14 release of the internal repository");
  });
});

describe("0.8.0's checksum files are named CHECKSUMS, which only the last 0.7.x looks for", () => {
  // 0.8.0's floor is 0.7.28, the last 0.7.x (owner, 2026-10-24) — after 0.7.27, which brought the last old form forward
  // (`[rsi]` as `[skills.learning]`). 0.7.21 and later read the new file name; 0.7.22, 0.7.23 and 0.7.27 were each the
  // floor once, and are below it now.
  const RELEASES = { "v0.8.0": withFloor("0.7.28"), "v0.7.28": SUMS, "v0.7.27": SUMS, "v0.7.23": SUMS, "v0.7.22": SUMS, "v0.7.21": SUMS, "v0.7.20": SUMS };
  const LIST = Object.keys(RELEASES).map((tag) => ({ tag, publishedAt: null, notesUrl: null, assets: assetsOf(tag) }));

  test("the name follows the release: SHA256SUMS through 0.7.x, CHECKSUMS from 0.8.0, per edition", () => {
    expect(checksumName("basic", "v0.7.21")).toBe("SHA256SUMS");
    expect(checksumName("pro", "v0.7.21")).toBe("SHA256SUMS-pro");
    expect(checksumName("basic", "v0.8.0")).toBe("CHECKSUMS");
    expect(checksumName("router", "v0.8.0")).toBe("CHECKSUMS-router");
    expect(checksumName("pro", "v1.2.3")).toBe("CHECKSUMS-pro");
  });

  test("an updater from before 0.7.21, which looks for SHA256SUMS whatever the release, passes 0.8.0 by", () => {
    // How every updater in the field picks a release: the tarball and that one file name.
    expect(newestCarrying(LIST, "nouride-linux-x64", () => "SHA256SUMS")?.tag).toBe("v0.7.28");
  });

  test("0.7.21 reads 0.8.0's CHECKSUMS, finds its floor, and is stepped to 0.7.28 first", async () => {
    const check = await checkForUpdate({ facts: { ...FACTS, version: "0.7.21" }, fetchImpl: channel(RELEASES) });
    expect(check.latest).toBe("v0.7.28");
    expect(check.floor?.message).toBe("update to 0.7.28 first; 0.8.0 needs it");
    expect(check.plan?.can && check.plan.checksumUrl).toEndWith("/v0.7.28/SHA256SUMS");
  });

  test("0.7.23 and 0.7.27 — each the floor once — are stepped to 0.7.28 first", async () => {
    for (const version of ["0.7.23", "0.7.27"]) {
      const check = await checkForUpdate({ facts: { ...FACTS, version }, fetchImpl: channel(RELEASES) });
      expect(check.latest).toBe("v0.7.28");
      expect(check.floor?.message).toBe("update to 0.7.28 first; 0.8.0 needs it");
      expect(check.plan?.can && check.plan.checksumUrl).toEndWith("/v0.7.28/SHA256SUMS");
    }
  });

  test("0.7.28 is offered 0.8.0, and fetches and verifies its CHECKSUMS", async () => {
    const check = await checkForUpdate({ facts: { ...FACTS, version: "0.7.28" }, fetchImpl: channel(RELEASES) });
    expect(check.latest).toBe("v0.8.0");
    expect(check.plan?.can && check.plan.checksumUrl).toEndWith("/v0.8.0/CHECKSUMS");
    expect(check.plan?.can && check.plan.signatureUrl).toEndWith("/v0.8.0/CHECKSUMS.sig");
  });

  test("an install below the floor that has this updater is stepped to 0.7.28 first", async () => {
    const check = await checkForUpdate({ facts: { ...FACTS, version: "0.7.20" }, fetchImpl: channel(RELEASES) });
    expect(check.latest).toBe("v0.7.28");
    expect(check.plan?.can && check.plan.checksumUrl).toEndWith("/v0.7.28/SHA256SUMS");
  });
});

describe("0.8.1's floor is 0.8.0: every 0.7.x crosses through it", () => {
  // Every release after 0.8.0 has 0.8.0 as its floor (owner, once 0.8.0 shipped); 0.8.0's own is 0.7.28. Nothing in the
  // updater names either version: each step is the newest release whose floor the running one meets.
  const RELEASES = {
    "v0.8.1": withFloor("0.8.0"),
    "v0.8.0": withFloor("0.7.28"),
    "v0.7.29": SUMS,
    "v0.7.28": SUMS,
    "v0.7.27": SUMS,
    "v0.7.21": SUMS,
    "v0.7.20": SUMS,
  };
  const LIST = Object.keys(RELEASES).map((tag) => ({ tag, publishedAt: null, notesUrl: null, assets: assetsOf(tag) }));
  const check = (version: string) => checkForUpdate({ facts: { ...FACTS, version }, fetchImpl: channel(RELEASES) });

  test("0.7.29 → 0.8.0 → 0.8.1, one start at each", async () => {
    const from0729 = await check("0.7.29");
    expect(from0729.latest).toBe("v0.8.0");
    expect(from0729.floor).toEqual({ release: "v0.8.1", needs: "0.8.0", message: "update to 0.8.0 first; 0.8.1 needs it" });
    expect(from0729.plan?.can && from0729.plan.checksumUrl).toEndWith("/v0.8.0/CHECKSUMS");
    expect(from0729.latestElsewhere).toBe("v0.8.1");

    const from080 = await check("0.8.0");
    expect(from080.latest).toBe("v0.8.1");
    expect(from080.floor).toBeUndefined();
    expect(from080.plan?.can && from080.plan.checksumUrl).toEndWith("/v0.8.1/CHECKSUMS");

    expect((await check("0.8.1")).newer).toBe(false);
  });

  test("0.7.28 is stepped to 0.8.0 too: it meets 0.8.0's floor, not 0.8.1's", async () => {
    const from0728 = await check("0.7.28");
    expect(from0728.latest).toBe("v0.8.0");
    expect(from0728.floor?.message).toBe("update to 0.8.0 first; 0.8.1 needs it");
  });

  test("a 0.7.x below 0.8.0's own floor is stepped to the last 0.7.x first, and told what 0.8.1 needs", async () => {
    const from0727 = await check("0.7.27");
    expect(from0727.latest).toBe("v0.7.29");
    expect(from0727.floor?.message).toBe("update to 0.7.29 first; 0.8.1 needs 0.8.0 or later");
    expect(from0727.plan?.can && from0727.plan.checksumUrl).toEndWith("/v0.7.29/SHA256SUMS");
  });

  test("an updater from before 0.7.21, which looks for SHA256SUMS, still stops at the last 0.7.x", () => {
    expect(newestCarrying(LIST, "nouride-linux-x64", () => "SHA256SUMS")?.tag).toBe("v0.7.29");
  });
});

describe("the install, whatever the check said", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nouride-floor-"));
    mkdirSync(join(root, "install"));
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "install", "nouride"), "old");
    writeFileSync(join(root, "release", "nouride"), "#!/bin/sh\necho new\n");
    chmodSync(join(root, "release", "nouride"), 0o755);
    spawnSync("tar", ["-czf", join(root, "r.tar.gz"), "-C", join(root, "release"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sums = (floor: string) => withFloor(floor, `${createHash("sha256").update(readFileSync(join(root, "r.tar.gz"))).digest("hex")}  ./nouride-linux-x64.tar.gz\n`);
  const install = (text: string, from: string) =>
    installStaged({
      installDir: join(root, "install"),
      tarball: join(root, "r.tar.gz"),
      swap: ["nouride"],
      checksumUrl: "https://example.invalid/v0.8.0/SHA256SUMS",
      artifact: "nouride-linux-x64",
      host: { platform: "linux", arch: "x64" },
      tag: "v0.8.0",
      from,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch,
    });

  test("refuses a release whose checksum file needs a newer version first, and moves nothing", async () => {
    await expect(install(sums("0.7.14"), "0.7.11")).rejects.toThrow(
      "0.8.0 needs 0.7.14 first, and this install runs 0.7.11: update to 0.7.14 first, then to 0.8.0",
    );
    expect(readFileSync(join(root, "install", "nouride"), "utf8")).toBe("old");
  });

  test("installs it on the floor's version", async () => {
    await install(sums("0.7.14"), "0.7.14");
    expect(readFileSync(join(root, "install", "nouride"), "utf8")).toContain("echo new");
  });
});
