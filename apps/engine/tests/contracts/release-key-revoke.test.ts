/**
 * Revoking a leaked release signing key, run through the release flow with keys made here and thrown away.
 *
 * The procedure for a leaked key was first written as one release: the new key into `RELEASE_SIGNING_KEY`, then a
 * release whose `install.sh` held only the new key, "signed with the old one". The flow cannot do that. `scripts/release/sign-checksums.sh` keeps a signature only when it verifies against the keys
 * the tagged `install.sh` embeds, so the old key cannot sign that release — and signed with the new one, every box,
 * which trusts only the keys of the build it runs, refuses it (`failed_verify`). What the code allows is two
 * releases: N with both keys, signed with the old one; then N+1 with the new key alone, signed with it. This runs
 * that order end to end, with the three checks a release meets: the signing script, a box's update
 * (`verifyChecksums`, as `install.ts` calls it with the keys compiled into the build), and a fresh install's
 * `install.sh` (`verify_release`, with the keys the release's own copy embeds).
 *
 * The real `install.sh` is used with its key block swapped, so a two-key block — which no release has carried yet —
 * is read by both shell scripts the way the real one would be. The real key is never touched.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChecksums } from "../../../../packages/update/src/signing.ts";

const ROOT = join(import.meta.dir, "../../../..");
const SIGN = join(ROOT, "scripts/release/sign-checksums.sh");
const INSTALL = readFileSync(join(ROOT, "scripts/install.sh"), "utf8");
const KEYS_FROM = "# >>> release keys\n";
const KEYS_TO = "# <<< release keys";
const FUNCTIONS = INSTALL.slice(INSTALL.indexOf("# >>> verify release\n"), INSTALL.indexOf("# <<< verify release"));

const rawin = spawnSync("sh", ["-c", "openssl pkeyutl -help 2>&1 | grep -q -- -rawin"]);
const hasOpenssl3 = rawin.status === 0;

const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
  };
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tagged tree's release: its `install.sh`, the real one embedding `keys`, and a checksum file of a tarball. */
function release(name: string, keys: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `nouride-revoke-${name}-`));
  dirs.push(dir);
  const at = INSTALL.indexOf(KEYS_FROM) + KEYS_FROM.length;
  writeFileSync(join(dir, "install.sh"), `${INSTALL.slice(0, at)}RELEASE_KEYS='${keys.join("\n")}'\n${INSTALL.slice(INSTALL.indexOf(KEYS_TO))}`);
  const tarball = join(dir, "nouride-linux-x64.tar.gz");
  writeFileSync(tarball, `the build of release ${name}`);
  const sums = `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ./nouride-linux-x64.tar.gz\n`;
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  return { dir, tarball, sums, keys };
}

/** The `sign` job: `sign-checksums.sh` with `RELEASE_SIGNING_KEY`, against the keys of the tagged `install.sh`. */
function sign(r: ReturnType<typeof release>, key: string) {
  const run = spawnSync("sh", [SIGN, join(r.dir, "SHA256SUMS")], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_SIGNING_KEY: key, RELEASE_KEYS_FROM: join(r.dir, "install.sh") },
  });
  const sigPath = join(r.dir, "SHA256SUMS.sig");
  return { status: run.status, stderr: run.stderr, signature: existsSync(sigPath) ? readFileSync(sigPath, "utf8") : undefined };
}

/** A fresh install running this release's own `install.sh`: `verify_release` with the keys that copy embeds. */
function freshInstall(r: ReturnType<typeof release>): string {
  const script = `die() { echo "DIE: $*"; exit 1; }\nwarn() { echo "WARN: $*"; }\nRELEASE_KEYS='${r.keys.join("\n")}'\n${FUNCTIONS}\nverify_release '${r.tarball}' '${join(r.dir, "SHA256SUMS")}' '${join(r.dir, "SHA256SUMS.sig")}' nouride-linux-x64 && echo "OK $VERIFIED_SIGNATURE"`;
  const run = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  return `${run.stdout}${run.stderr}`.trim();
}

describe.skipIf(!hasOpenssl3)("revoking a leaked release key: two releases, in the order the release flow allows", () => {
  const leaked = keypair();
  const next = keypair();
  /** What a box trusts: the keys compiled into the build it runs. */
  const boxBeforeN = [leaked.publicPem];
  const boxOnN = [leaked.publicPem, next.publicPem];
  const boxOnN1 = [next.publicPem];

  test("release N: both keys, signed with the leaked one — signed, and taken by a box that predates it", () => {
    const n = release("n", [leaked.publicPem, next.publicPem]);
    const signed = sign(n, leaked.privatePem);
    expect(signed.status).toBe(0);
    expect(verifyChecksums(n.sums, signed.signature!, boxBeforeN)).toBe(true);
    expect(verifyChecksums(n.sums, signed.signature!, boxOnN)).toBe(true);
    expect(freshInstall(n)).toBe("OK 1");
    // Both shell scripts read the whole two-key block, not its first key: a signature by the second verifies too.
    const second = sign(n, next.privatePem);
    expect(second.status).toBe(0);
    expect(freshInstall(n)).toBe("OK 1");
  });

  test("the new key in RELEASE_SIGNING_KEY before N is out: one release cannot be signed, or no box takes it", () => {
    const onlyNew = release("one-release", [next.publicPem]);
    // Signed with the old key, as the page once said: the script refuses, since the tagged install.sh no longer has it.
    const old = sign(onlyNew, leaked.privatePem);
    expect(old.status).not.toBe(0);
    expect(old.stderr).toContain("does not verify against the keys every build trusts");
    expect(old.signature).toBeUndefined();
    // Signed with the new one, which the secret holds by then: published — and refused by every box, which trusts only
    // the leaked key until it has taken N.
    const fresh = sign(onlyNew, next.privatePem);
    expect(fresh.status).toBe(0);
    expect(verifyChecksums(onlyNew.sums, fresh.signature!, boxBeforeN)).toBe(false);
  });

  test("release N+1: the new key alone, signed with it — a box on N takes it, one that never took N cannot", () => {
    const n1 = release("n1", [next.publicPem]);
    const signed = sign(n1, next.privatePem);
    expect(signed.status).toBe(0);
    expect(verifyChecksums(n1.sums, signed.signature!, boxOnN)).toBe(true);
    // Never took N: it refuses N+1 and every release after it (`failed_verify`), and goes on trusting the leaked key.
    expect(verifyChecksums(n1.sums, signed.signature!, boxBeforeN)).toBe(false);
    // A free install that missed N reinstalls with N+1's own install.sh, which carries the new key.
    expect(freshInstall(n1)).toBe("OK 1");
  });

  test("after N+1, nothing the leaked key signs is taken: not by a box on N+1, and not by the release flow", () => {
    const later = release("later", [next.publicPem]);
    // The release flow: the tagged install.sh holds only the new key, so the leaked one cannot sign a release.
    expect(sign(later, leaked.privatePem).status).not.toBe(0);
    // A release whoever holds the leaked key signs by hand, outside the flow: a box past N+1 refuses it, a box still
    // on N or before it does not — which is why N+1 follows N at once.
    const forged = release("forged", [leaked.publicPem]);
    const signature = sign(forged, leaked.privatePem).signature!;
    expect(verifyChecksums(forged.sums, signature, boxOnN1)).toBe(false);
    expect(verifyChecksums(forged.sums, signature, boxOnN)).toBe(true);
    expect(verifyChecksums(forged.sums, signature, boxBeforeN)).toBe(true);
  });
});
