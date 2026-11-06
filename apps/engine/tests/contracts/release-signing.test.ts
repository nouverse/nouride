/**
 * The release signing key every install and every box trusts is held by one job, `sign`, which installs nothing:
 * it sat in `binaries`, after `bun install` and the build, where a dependency's install script ran beside it. And the
 * script that job runs signs with OpenSSL alone (`scripts/release/sign-checksums.sh`), checking each signature against
 * the keys install.sh embeds before keeping it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SCRIPT = join(ROOT, "scripts/release/sign-checksums.sh");
const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

/** Each job's text, by name: the lines under `jobs:` from one two-space key to the next. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = body.split(/^(?= {2}[a-z][a-z-]*:\s*$)/m);
  return new Map(parts.map((part): [string, string] => [/^ {2}([a-z][a-z-]*):/.exec(part)?.[1] ?? "", part]).filter(([name]) => name));
}

describe("the release workflow", () => {
  const all = jobs(release);

  test("holds the signing key and the appliance token in one job, `sign`, and in no other", () => {
    for (const secret of ["secrets.RELEASE_SIGNING_KEY", "secrets.NOUVERSE_RELEASE_TOKEN"]) {
      expect([...all].filter(([, text]) => text.includes(secret)).map(([name]) => name)).toEqual(["sign"]);
    }
  });

  test("whose job installs nothing, runs where the one switch says as every job does, and waits for every build", () => {
    const sign = all.get("sign")!;
    expect(sign).not.toMatch(/bun install|npm (ci|install)|bun add/);
    // GitHub's fresh runner unless CI_RUNNER names another — the one line that moves the whole release.
    expect(sign).toContain(`runs-on: \${{ fromJSON(vars.CI_RUNNER || '"ubuntu-24.04"') }}`);
    // Every build whose checksum file it signs: the tarballs, and the public images' kits, made by `binaries` (0.7.21).
    expect(sign).toContain("needs: [binaries, guard-visibility]");
    expect(sign).toContain("sh scripts/release/sign-checksums.sh");
    // And the release's last check reads what it did: a checksum file with no signature fails the run.
    expect(all.get("release")).toContain("needs: [binaries, sign, guard-visibility]");
    expect(all.get("release")).toContain("has no signature beside it");
  });
});

const rawin = spawnSync("openssl", ["pkeyutl", "-help"], { encoding: "utf8" });
const hasOpenssl3 = `${rawin.stdout}${rawin.stderr}`.includes("-rawin");

describe.skipIf(!hasOpenssl3)("sign-checksums.sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const keypair = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
  };
  /** A checksum file, and an install.sh embedding `trusted` the way the real one does. */
  const release = (trusted: string) => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-sign-"));
    dirs.push(dir);
    writeFileSync(join(dir, "install.sh"), `#!/bin/sh\n# >>> release keys\nRELEASE_KEYS='${trusted.trim()}'\n# <<< release keys\n`);
    writeFileSync(join(dir, "SHA256SUMS"), "0123abcd  ./nouride-linux-x64.tar.gz\n");
    return dir;
  };
  const sign = (dir: string, key: string, keysFrom?: string) =>
    spawnSync("sh", [SCRIPT, join(dir, "SHA256SUMS")], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_SIGNING_KEY: key, ...(keysFrom ? { RELEASE_KEYS_FROM: keysFrom } : { RELEASE_KEYS_FROM: "" }) },
    });

  test("writes `<file>.sig`: the base64 of an Ed25519 signature over the file's exact bytes, as updates verify it", () => {
    const key = keypair();
    const dir = release(key.publicPem);
    const run = sign(dir, key.privatePem, join(dir, "install.sh"));
    expect(run.status).toBe(0);
    const sig = readFileSync(join(dir, "SHA256SUMS.sig"), "utf8");
    expect(sig.endsWith("\n")).toBe(true);
    expect(verify(null, readFileSync(join(dir, "SHA256SUMS")), createPublicKey(key.publicPem), Buffer.from(sig.trim(), "base64"))).toBe(true);
  });

  test("refuses a key whose signature none of the trusted keys verifies, and leaves no signature behind", () => {
    const dir = release(keypair().publicPem);
    const run = sign(dir, keypair().privatePem, join(dir, "install.sh"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("does not verify against the keys every build trusts");
    expect(existsSync(join(dir, "SHA256SUMS.sig"))).toBe(false);
  });

  test("by default trusts the keys the real install.sh embeds — a throwaway key is refused against them", () => {
    const dir = release(keypair().publicPem);
    const run = spawnSync("sh", [SCRIPT, join(dir, "SHA256SUMS")], { encoding: "utf8", env: { ...process.env, RELEASE_SIGNING_KEY: keypair().privatePem } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("does not verify");
  });
});
