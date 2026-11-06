/**
 * Installing what was downloaded: five decisions, and what it leaves behind.
 *
 * None of this had a test (`tests-update-apply-orchestration-untested`). It was reachable only through the
 * process's one update provider and one transfer, and the test that stubbed the module replaced it for every file
 * after it in the run. So the function takes what it reads (`installStagedDownload`), and this hands it fakes:
 *
 * - nothing staged: refused;
 * - staged against a release that is no longer the newest: refused — install it, and the wrong version is on disk
 *   under the right version's name;
 * - nothing newer at all: refused;
 * - newer, and this install cannot take it: refused, with what it can do instead;
 * - the check could not be made — the 403 a rate-limited API gave a finished download — installed anyway, verified
 *   against the checksum file and signature the release's tag names.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStagedDownload, type StagedInstallDeps, type UpdateCheck } from "@/modules/update/index.ts";
import { SWAPPED } from "@/service/update-guard.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-install-downloaded-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const facts = (): StagedInstallDeps["facts"] => ({
  version: "0.7.8",
  edition: "basic",
  installDir: dir,
  installDirWritable: true,
  supervisor: "systemd",
  restartsOnExit: true,
  compiled: true,
  platform: "linux",
  arch: "x64",
  musl: false,
});

const source: StagedInstallDeps["source"] = {
  name: "github",
  releases: async () => [],
  tarballUrl: (tag, artifact) => `https://get.test/${tag}/${artifact}.tar.gz`,
  checksumUrl: (tag, sums) => `https://get.test/${tag}/${sums}`,
  signatureUrl: (tag, sums) => `https://get.test/${tag}/${sums}.sig`,
  staleness: () => null,
};

const plan = (to: string) => ({
  can: true as const,
  from: "0.7.8",
  to,
  artifact: "nouride-linux-x64",
  tarballUrl: `https://get.test/${to}/nouride-linux-x64.tar.gz`,
  checksumUrl: `https://plan.test/${to}/SHA256SUMS`,
  checksumFile: "SHA256SUMS",
  signatureUrl: `https://plan.test/${to}/SHA256SUMS.sig`,
});

const answer = (fields: Partial<UpdateCheck>): UpdateCheck => ({ current: "0.7.8", latest: "v0.7.9", newer: true, track: "latest", publishedAt: null, notesUrl: null, ...fields });

/** One run, with `check` as the channel's answer and a download staged unless `staged` says otherwise. */
function harness(check: () => Promise<UpdateCheck>, staged: Partial<ReturnType<StagedInstallDeps["download"]["snapshot"]>> = {}) {
  const installs: Record<string, unknown>[] = [];
  let discarded = 0;
  const backupDir = join(dir, ".nouride-previous");
  const deps: StagedInstallDeps = {
    mod: {
      checkForUpdate: check,
      installStaged: async (input) => {
        installs.push(input);
        // What the real swap leaves: the build it replaced, kept.
        mkdirSync(backupDir, { recursive: true });
        return { replaced: ["nouride", "dashboard"], backupDir, bytes: 1, sha256: "ab" };
      },
      checksumName: (edition) => (edition === "basic" ? "SHA256SUMS" : `SHA256SUMS-${edition}`),
      // From 0.7.4 on every public release is signed — the rule is the plugin's; the engine hands it the tag.
      requiresSignature: (edition, tag) => edition !== "basic" || tag === "v0.7.9",
    } as StagedInstallDeps["mod"],
    source,
    facts: facts(),
    download: {
      snapshot: () => ({ status: "ready", received: 10, total: 10, tag: "v0.7.9", artifact: "nouride-linux-x64", path: join(dir, "dl.tar.gz"), error: null, ...staged }),
      discard: async () => {
        discarded += 1;
      },
    },
    fetchImpl: fetch,
  };
  return { deps, installs, discarded: () => discarded, backupDir };
}

const pending = () => join(dir, ".nouride-pending-update");

describe("installing what was downloaded", () => {
  test("installs the release the check still names, and leaves the way back and the probation marker", async () => {
    const run = harness(async () => answer({ plan: plan("v0.7.9") }));
    const result = await installStagedDownload(run.deps);

    expect(run.installs).toHaveLength(1);
    // Verified against the files the plan named, the signature included.
    expect(run.installs[0]).toMatchObject({
      installDir: dir,
      tarball: join(dir, "dl.tar.gz"),
      checksumUrl: "https://plan.test/v0.7.9/SHA256SUMS",
      signatureUrl: "https://plan.test/v0.7.9/SHA256SUMS.sig",
      artifact: "nouride-linux-x64",
      edition: "basic",
      tag: "v0.7.9",
      // The names the unit's guard and `--rollback` put back, so the plugin swaps nothing they would not restore.
      swap: SWAPPED,
    });
    expect(result.plan.to).toBe("v0.7.9");
    // The kept build says what it is and who put it aside — `nouride update --rollback` reads it.
    expect(JSON.parse(readFileSync(join(run.backupDir, "release.json"), "utf8"))).toMatchObject({ version: "0.7.8", by: "v0.7.9" });
    // The new version is on probation: the unit's guard counts its starts until it confirms itself.
    expect(JSON.parse(readFileSync(pending(), "utf8"))).toMatchObject({ from: "0.7.8", to: "0.7.9" });
    expect(run.discarded()).toBe(1);
  });

  test("nothing downloaded is refused before the channel is asked", async () => {
    let asked = 0;
    const run = harness(
      async () => {
        asked += 1;
        return answer({ plan: plan("v0.7.9") });
      },
      { status: "downloading" },
    );
    await expect(installStagedDownload(run.deps)).rejects.toThrow("nothing has been downloaded yet");
    expect({ asked, installs: run.installs.length, pending: existsSync(pending()) }).toEqual({ asked: 0, installs: 0, pending: false });
  });

  test("a download of a release that is no longer the newest is refused, not installed under the new one's name", async () => {
    const run = harness(async () => answer({ latest: "v0.7.10", plan: plan("v0.7.10") }));
    await expect(installStagedDownload(run.deps)).rejects.toThrow("the downloaded release is v0.7.9, and the newest is now v0.7.10: download again");
    expect({ installs: run.installs.length, pending: existsSync(pending()), discarded: run.discarded() }).toEqual({ installs: 0, pending: false, discarded: 0 });
  });

  test("nothing newer is refused", async () => {
    const run = harness(async () => answer({ latest: "0.7.8", newer: false }));
    await expect(installStagedDownload(run.deps)).rejects.toThrow("there is nothing to install: this install is on 0.7.8");
    expect(run.installs).toHaveLength(0);
  });

  test("an install that can no longer take it is refused with what it can do — not swapped and stopped", async () => {
    // Downloaded while a service ran it; the service gone by the time of the install. Swapping would be a stop.
    const refusal = { can: false as const, from: "0.7.8", to: "v0.7.9", reason: "nothing would restart this daemon after the swap", instead: ["install a service first: nouride service install"] };
    const run = harness(async () => answer({ plan: refusal }));
    await expect(installStagedDownload(run.deps)).rejects.toThrow("nothing would restart this daemon after the swap. Instead: install a service first");
    expect({ installs: run.installs.length, pending: existsSync(pending()) }).toEqual({ installs: 0, pending: false });
  });

  test("a check that cannot be made is stepped over, and the release is still verified by its own tag's files", async () => {
    // The incident: a finished download met "the release channel answered 403" instead of installing.
    const run = harness(async () => {
      throw new Error("the release channel answered 403 — this is usually the hourly rate limit");
    });
    await installStagedDownload(run.deps);
    expect(run.installs).toHaveLength(1);
    expect(run.installs[0]).toMatchObject({
      checksumUrl: "https://get.test/v0.7.9/SHA256SUMS",
      // A public release from 0.7.4 on must be signed, and this path used to skip it.
      signatureUrl: "https://get.test/v0.7.9/SHA256SUMS.sig",
      tag: "v0.7.9",
      // With no check to say whether a floor stands in the way, the plugin reads it from the signed file itself —
      // against the version that is installing.
      from: "0.7.8",
    });
    expect(existsSync(pending())).toBe(true);
  });

  test("a failed check is told from a refusal by what it is, not by its wording", async () => {
    // These were told apart by a regex on the message, so a failure whose text happened to match was a refusal.
    const run = harness(async () => {
      throw new Error("the release channel answered 503 — nothing to install until it is back; download again later");
    });
    await installStagedDownload(run.deps);
    expect(run.installs).toHaveLength(1);
  });
});
